use hashtree_sim::{run_parameter_sweep, PoolConfig, SimConfig};
use std::time::Duration;

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
    score: f64,
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

        // Lower is better: penalize failures and fragmentation heavily.
        let score = (1.0 - avg_success_rate) * 1200.0
            + avg_p95_ms
            + avg_overhead_ratio * 60.0
            + (avg_component_count - 1.0).max(0.0) * 200.0
            + (1.0 - avg_largest_component_share) * 600.0;

        summaries.push(Summary {
            max_connections,
            satisfied_connections,
            runs,
            avg_success_rate,
            avg_p95_ms,
            avg_overhead_ratio,
            avg_component_count,
            avg_largest_component_share,
            score,
        });
    }

    summaries.sort_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    println!(
        "\nRanked candidates (lower score is better):\nmax/sat | runs | success | p95_ms | overhead | components | largest_share | score"
    );
    for s in summaries {
        println!(
            "{:>2}/{:<2} | {:>4} | {:>6.2}% | {:>7.1} | {:>8.3} | {:>10.2} | {:>13.3} | {:>7.1}",
            s.max_connections,
            s.satisfied_connections,
            s.runs,
            s.avg_success_rate * 100.0,
            s.avg_p95_ms,
            s.avg_overhead_ratio,
            s.avg_component_count,
            s.avg_largest_component_share,
            s.score,
        );
    }
}
