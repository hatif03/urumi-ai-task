import { scene, closeBrowser, DASH } from "./lib.ts";
await scene("t0", "smoke", async (s) => {
  await s.setCaption("2 · Kubernetes", "what runs where");
  await s.openTerminal("ssh ubuntu@vps");
  await s.say("Namespaces first.", async () => { await s.run("kubectl get ns"); });
  await s.say("Then the pods.", async () => { await s.run("kubectl get pods -n platform"); });
  await s.goto(`https://${DASH}/`);
  await s.type('input[name="username"]', "ada");
  await s.say("Dashboard login page.");
});
await closeBrowser();
