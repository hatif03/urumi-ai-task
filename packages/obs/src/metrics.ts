type Labels = Record<string, string>;

const BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 8, 30];

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

function formatLabels(labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key].replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

class Registry {
  private counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private gauges = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private histograms = new Map<
    string,
    Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>
  >();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.series(this.counters, name);
    const key = labelKey(labels);
    const current = series.get(key) ?? { labels, value: 0 };
    current.value += by;
    series.set(key, current);
  }

  setGauge(name: string, labels: Labels, value: number): void {
    const series = this.series(this.gauges, name);
    series.set(labelKey(labels), { labels, value });
  }

  observe(name: string, labels: Labels, value: number): void {
    const series = this.series(this.histograms, name);
    const key = labelKey(labels);
    const current = series.get(key) ?? {
      labels,
      buckets: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    current.sum += value;
    current.count += 1;
    const bucket = BUCKETS.findIndex((bound) => value <= bound);
    if (bucket >= 0) current.buckets[bucket] += 1;
    series.set(key, current);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const sample of series.values()) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    for (const [name, series] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const sample of series.values()) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    for (const [name, series] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const sample of series.values()) {
        let cumulative = 0;
        BUCKETS.forEach((bound, index) => {
          cumulative += sample.buckets[index] ?? 0;
          lines.push(`${name}_bucket${formatLabels({ ...sample.labels, le: String(bound) })} ${cumulative}`);
        });
        lines.push(`${name}_bucket${formatLabels({ ...sample.labels, le: "+Inf" })} ${sample.count}`);
        lines.push(`${name}_sum${formatLabels(sample.labels)} ${sample.sum}`);
        lines.push(`${name}_count${formatLabels(sample.labels)} ${sample.count}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private series<T>(map: Map<string, Map<string, T>>, name: string): Map<string, T> {
    let found = map.get(name);
    if (!found) {
      found = new Map();
      map.set(name, found);
    }
    return found;
  }
}

export const metrics = new Registry();

export function renderMetrics(): string {
  return metrics.render();
}

export function observeDuration(name: string, labels: Labels, startedAt: number): void {
  metrics.observe(name, labels, (performance.now() - startedAt) / 1000);
}
