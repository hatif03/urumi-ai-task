import type { SQL } from "bun";
import { log, metrics } from "@urumi/obs";
import { advance, claim, heartbeat, release, setReason, type Table, type Work } from "./db.ts";
import type { Gateway, Helm, Kube } from "./ports.ts";

export type Config = {
  platformNamespace: string;
  provisionTimeoutSeconds: number;
  maxHelmSeconds: number;
  storesDomain: string;
  storesScheme: "http" | "https";
  storeChart: string;
  hostedChart: string;
  hostedNamespace: string;
  hostedRegistries: string[];
  hostedPullPolicy: string;
  maxStoresPerUser: number;
  // Extra chart values for every store (storage class, image repositories, ingress class, TLS issuer).
  storeValues: Record<string, unknown>;
  hostedValues: Record<string, unknown>;
  serviceAccount: string;
};

export type Deps = { sql: SQL; helm: Helm; kube: Kube; gateway: Gateway; config: Config };

export type StepContext = { work: Work; deps: Deps; signal: AbortSignal };
export type StepResult = { next: string } | { ready: true } | { forget: true };
export type Step = (ctx: StepContext) => Promise<StepResult>;

// Thrown by a step when the condition may pass by itself (the gateway cannot reach a pod yet, a
// namespace is still terminating). The row keeps its phase and is tried again after the delay.
export class Retry extends Error {
  constructor(message: string, readonly delaySeconds = 3) {
    super(message);
  }
}

// Thrown when no retry will help. The row becomes "failed" and the message is the reason shown to the user.
export class Fail extends Error {}

const LEASE_SECONDS = 60;
const DEFAULT_HEARTBEAT_MS = 5000;

// One worker per table. It claims a row, then runs that row's state machine until it is ready, failed,
// forgotten, or the lease is lost. Every step is idempotent, so running it twice (after a crash, or
// after a retry) converges on the same state. The phase is written after each step: a restart resumes there.
export class Worker {
  constructor(
    private readonly deps: Deps,
    private readonly table: Table,
    private readonly steps: Record<string, Step>,
    private readonly owner: string,
    private readonly onReady?: (work: Work) => void,
    private readonly heartbeatMs = DEFAULT_HEARTBEAT_MS,
  ) {}

  async tick(): Promise<boolean> {
    const work = await claim(this.deps.sql, this.table, this.owner, LEASE_SECONDS);
    if (!work) return false;
    await this.run(work);
    return true;
  }

  private async run(start: Work): Promise<void> {
    const { sql } = this.deps;
    let work = start;
    const abort = new AbortController();
    // Extends the lease while a long step (helm --wait) runs, and cancels the step if a delete request
    // changed the row underneath it.
    const beat = setInterval(async () => {
      const current = await heartbeat(sql, this.table, work.id, this.owner, LEASE_SECONDS).catch(() => null);
      if (!current || current.status !== work.status) abort.abort();
    }, this.heartbeatMs);
    try {
      while (!abort.signal.aborted) {
        if (work.status === "provisioning" && Date.now() > work.deadlineAt.getTime()) {
          await advance(sql, this.table, work, { status: "failed", reason: `timed out in phase "${work.phase}" after ${this.deps.config.provisionTimeoutSeconds}s${work.reason ? `: ${work.reason}` : ""}` });
          metrics.inc("provision_failed_total", { table: this.table, phase: work.phase });
          return;
        }
        const step = this.steps[`${work.status}:${work.phase}`];
        if (!step) {
          await advance(sql, this.table, work, { status: "failed", reason: `internal error: no step for ${work.status}:${work.phase}` });
          return;
        }
        let result: StepResult;
        try {
          result = await step({ work, deps: this.deps, signal: abort.signal });
        } catch (error) {
          if (abort.signal.aborted) return;
          if (error instanceof Fail || (error as { permanent?: boolean }).permanent) {
            const message = error instanceof Error ? error.message : String(error);
            log("warn", "step failed", { table: this.table, id: work.id, phase: work.phase, reason: message });
            metrics.inc("provision_failed_total", { table: this.table, phase: work.phase });
            // A failed delete never becomes "failed": it stays deleting and is retried, with the reason visible.
            if (work.status === "deleting") await this.retryLater(work, message, 15);
            else await advance(sql, this.table, work, { status: "failed", reason: message });
            return;
          }
          const delay = error instanceof Retry ? error.delaySeconds : 5;
          if (!(error instanceof Retry)) metrics.inc("provisioner_step_errors_total", { table: this.table, phase: work.phase });
          log("warn", "step will be retried", { table: this.table, id: work.id, phase: work.phase, error: error instanceof Error ? error.message : String(error) });
          await this.retryLater(work, `retrying ${work.phase}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), delay);
          return;
        }
        if ("forget" in result) {
          await sql.unsafe(`delete from ${this.table} where id = $1 and status = 'deleting'`, [work.id]);
          return;
        }
        if ("ready" in result) {
          if (await advance(sql, this.table, work, { status: "ready", phase: "done", reason: "", ready: true })) {
            metrics.observe("store_provision_duration_seconds", { table: this.table }, (Date.now() - work.createdAt.getTime()) / 1000);
            this.onReady?.(work);
          }
          return;
        }
        // reason is cleared on progress: the last retry message is no longer true
        if (!(await advance(sql, this.table, work, { phase: result.next, reason: "" }))) return;
        work = { ...work, phase: result.next, reason: "" };
      }
    } finally {
      clearInterval(beat);
      await release(sql, this.table, start.id, this.owner).catch(() => undefined);
    }
  }

  private async retryLater(work: Work, reason: string, delaySeconds: number): Promise<void> {
    await setReason(this.deps.sql, this.table, work.id, reason);
    await release(this.deps.sql, this.table, work.id, this.owner, delaySeconds);
  }
}

export function randomSecret(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}
