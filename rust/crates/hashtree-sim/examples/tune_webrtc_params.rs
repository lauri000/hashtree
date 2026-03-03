use hashtree_sim::{run_parameter_sweep, PoolConfig, SimConfig};
use std::time::Duration;

// Gate thresholds for this fast, noisy CI-style sweep.
// For longer runs, raise these (especially min_success_rate).
const MIN_SUCCESS_RATE: f64 = 0.12;
const MIN_LARGEST_COMPONENT_SHARE: f64 = 0.90;
const MAX_COMPONENT_COUNT: f64 = 3.0;

#[derive(Debug)]
struct Summary {
    max_connections: usize,
    satisfied_connections: usize,
    runs: usize,
    avg_success_rate: f64,
    avg_p95_ms: f64,
    avg_overhead_ratio: f64,
    avg_component_count: f64,
    avg_largest_component_share: f64,
    avg_tick_p95_us: f64,
    avg_peak_connection_pairs: f64,
    passes_gates: bool,
    gate_failures: Vec<&'static str>,
    score: f64,
}

fn ratio_score(
    avg_success_rate: f64,
    avg_p95_ms: f64,
    avg_overhead_ratio: f64,
    avg_component_count: f64,
    avg_largest_component_share: f64,
    avg_tick_p95_us: f64,
    avg_peak_connection_pairs: f64,
) -> (bool, Vec<&'static str>, f64) {
    let mut failures = Vec::new();
    if avg_success_rate < MIN_SUCCESS_RATE {
        failures.push("success");
    }
    if avg_largest_component_share < MIN_LARGEST_COMPONENT_SHARE {
        failures.push("largest_component");
    }
    if avg_component_count > MAX_COMPONENT_COUNT {
        failures.push("components");
    }
    if !failures.is_empty() {
        return (false, failures, 0.0);
    }

    let good = avg_success_rate.powf(3.0) * avg_largest_component_share.powf(2.0);
    let bad = (1.0 + avg_p95_ms / 50.0).ln()
        + 0.8 * (1.0 + avg_overhead_ratio).ln()
        + 0.5 * (1.0 + avg_tick_p95_us / 2000.0).ln()
        + 0.3 * (1.0 + avg_peak_connection_pairs / 200.0).ln();
    let score = good / (1.0 + bad);
    (true, failures, score)
}

#[tokio::main]
async fn main() {
    let seeds = [11_u64, 22, 33, 44];
    let candidates = [(16_usize, 8_usize), (18, 9), (20, 10), (24, 12)];

    let mut configs = Vec::new();
    for (max_connections, satisfied_connections) in candidates {
        for seed in seeds {
            configs.push(SimConfig {
                node_count: 60,
                duration: Duration::from_secs(3),
                seed,
                pool: PoolConfig {
                    max_connections,
                    satisfied_connections,
                },
                discovery_interval_ms: 100,
                churn_rate: 0.02,
                allow_rejoin: true,
                network_latency_ms: 30,
                retrieval_probe_count: 15,
                retrieval_payload_bytes: 2048,
                retrieval_timeout_ms: 700,
                max_events_retained: 10_000,
            });
        }
    }

    println!(
        "Running {} configs ({} candidates x {} seeds)...",
        configs.len(),
        candidates.len(),
        seeds.len()
    );

    let results = run_parameter_sweep(&configs).await;

    let mut summaries = Vec::new();
    for (max_connections, satisfied_connections) in candidates {
        let mut success_sum = 0.0;
        let mut p95_sum = 0.0;
        let mut overhead_sum = 0.0;
        let mut component_sum = 0.0;
        let mut largest_share_sum = 0.0;
        let mut tick_p95_sum = 0.0;
        let mut peak_links_sum = 0.0;
        let mut runs = 0_usize;

        for result in &results {
            if result.config.pool.max_connections != max_connections
                || result.config.pool.satisfied_connections != satisfied_connections
            {
                continue;
            }
            runs += 1;
            success_sum += result.stats.retrieval.success_rate;
            p95_sum += result.stats.retrieval.p95_latency_ms as f64;
            let overhead = if result.stats.retrieval.payload_bytes == 0 {
                0.0
            } else {
                result.stats.retrieval.data_plane_bytes as f64
                    / result.stats.retrieval.payload_bytes as f64
            };
            overhead_sum += overhead;
            component_sum += result.final_topology.component_count as f64;
            tick_p95_sum += result.stats.local_resources.tick_p95_us as f64;
            peak_links_sum += result.stats.local_resources.peak_connection_pairs as f64;
            let largest_share = if result.final_topology.node_count == 0 {
                0.0
            } else {
                result.final_topology.largest_component as f64
                    / result.final_topology.node_count as f64
            };
            largest_share_sum += largest_share;
        }

        if runs == 0 {
            continue;
        }

        let avg_success_rate = success_sum / runs as f64;
        let avg_p95_ms = p95_sum / runs as f64;
        let avg_overhead_ratio = overhead_sum / runs as f64;
        let avg_component_count = component_sum / runs as f64;
        let avg_largest_component_share = largest_share_sum / runs as f64;
        let avg_tick_p95_us = tick_p95_sum / runs as f64;
        let avg_peak_connection_pairs = peak_links_sum / runs as f64;

        let (passes_gates, gate_failures, score) = ratio_score(
            avg_success_rate,
            avg_p95_ms,
            avg_overhead_ratio,
            avg_component_count,
            avg_largest_component_share,
            avg_tick_p95_us,
            avg_peak_connection_pairs,
        );

        summaries.push(Summary {
            max_connections,
            satisfied_connections,
            runs,
            avg_success_rate,
            avg_p95_ms,
            avg_overhead_ratio,
            avg_component_count,
            avg_largest_component_share,
            avg_tick_p95_us,
            avg_peak_connection_pairs,
            passes_gates,
            gate_failures,
            score,
        });
    }

    summaries.sort_by(|a, b| match (a.passes_gates, b.passes_gates) {
        (true, true) => b
            .score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => b
            .avg_success_rate
            .partial_cmp(&a.avg_success_rate)
            .unwrap_or(std::cmp::Ordering::Equal),
    });

    println!(
        "\nRanked candidates (accepted first, higher score is better):\nmax/sat | runs | success | p95_ms | overhead | components | largest_share | tick_p95_us | peak_links | gates | score"
    );
    for s in summaries {
        let gate_str = if s.passes_gates {
            "pass".to_string()
        } else {
            format!("fail({})", s.gate_failures.join(","))
        };
        println!(
            "{:>2}/{:<2} | {:>4} | {:>6.2}% | {:>7.1} | {:>8.3} | {:>10.2} | {:>13.3} | {:>11.1} | {:>10.1} | {:>17} | {:>8.5}",
            s.max_connections,
            s.satisfied_connections,
            s.runs,
            s.avg_success_rate * 100.0,
            s.avg_p95_ms,
            s.avg_overhead_ratio,
            s.avg_component_count,
            s.avg_largest_component_share,
            s.avg_tick_p95_us,
            s.avg_peak_connection_pairs,
            gate_str,
            s.score,
        );
    }
}
