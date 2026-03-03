use hashtree_sim::{run_parameter_sweep, NodeStrategyProfile, PoolConfig, SimConfig};
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
    avg_tick_p95_us: f64,
    avg_peak_connection_pairs: f64,
    run_success_rates: Vec<f64>,
    run_largest_component_shares: Vec<f64>,
    run_component_counts: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct GateProfile {
    name: &'static str,
    min_success_rate: f64,
    min_largest_component_share: f64,
    max_component_count: f64,
    max_failed_runs: usize,
}

#[derive(Debug)]
struct ScoredSummary {
    summary: Summary,
    passes_gates: bool,
    failed_runs: usize,
    gate_failures: Vec<&'static str>,
    score: f64,
}

fn ratio_score(summary: &Summary, profile: GateProfile) -> (bool, usize, Vec<&'static str>, f64) {
    let mut failures = Vec::new();
    if summary.avg_success_rate < profile.min_success_rate {
        failures.push("avg_success");
    }
    if summary.avg_largest_component_share < profile.min_largest_component_share {
        failures.push("avg_largest_component");
    }
    if summary.avg_component_count > profile.max_component_count {
        failures.push("avg_components");
    }

    let mut failed_runs = 0usize;
    for idx in 0..summary.runs {
        if summary.run_success_rates[idx] < profile.min_success_rate
            || summary.run_largest_component_shares[idx] < profile.min_largest_component_share
            || summary.run_component_counts[idx] > profile.max_component_count
        {
            failed_runs += 1;
        }
    }
    if failed_runs > profile.max_failed_runs {
        failures.push("run_failures");
    }

    if !failures.is_empty() {
        return (false, failed_runs, failures, 0.0);
    }

    let good = summary.avg_success_rate.powf(3.0) * summary.avg_largest_component_share.powf(2.0);
    let bad = (1.0 + summary.avg_p95_ms / 50.0).ln()
        + 0.8 * (1.0 + summary.avg_overhead_ratio).ln()
        + 0.5 * (1.0 + summary.avg_tick_p95_us / 2000.0).ln()
        + 0.3 * (1.0 + summary.avg_peak_connection_pairs / 200.0).ln();
    let score = good / (1.0 + bad);
    (true, failed_runs, failures, score)
}

fn print_ranked_for_profile(profile: GateProfile, summaries: &[Summary]) {
    let mut scored: Vec<ScoredSummary> = summaries
        .iter()
        .map(|summary| {
            let (passes_gates, failed_runs, gate_failures, score) = ratio_score(summary, profile);
            ScoredSummary {
                summary: Summary {
                    max_connections: summary.max_connections,
                    satisfied_connections: summary.satisfied_connections,
                    runs: summary.runs,
                    avg_success_rate: summary.avg_success_rate,
                    avg_p95_ms: summary.avg_p95_ms,
                    avg_overhead_ratio: summary.avg_overhead_ratio,
                    avg_component_count: summary.avg_component_count,
                    avg_largest_component_share: summary.avg_largest_component_share,
                    avg_tick_p95_us: summary.avg_tick_p95_us,
                    avg_peak_connection_pairs: summary.avg_peak_connection_pairs,
                    run_success_rates: summary.run_success_rates.clone(),
                    run_largest_component_shares: summary.run_largest_component_shares.clone(),
                    run_component_counts: summary.run_component_counts.clone(),
                },
                passes_gates,
                failed_runs,
                gate_failures,
                score,
            }
        })
        .collect();

    scored.sort_by(|a, b| match (a.passes_gates, b.passes_gates) {
        (true, true) => b
            .score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => a.failed_runs.cmp(&b.failed_runs).then_with(|| {
            b.summary
                .avg_success_rate
                .partial_cmp(&a.summary.avg_success_rate)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    });

    println!(
        "\nProfile: {} (accepted first, higher score is better)\nmax/sat | runs | success | p95_ms | overhead | components | largest_share | tick_p95_us | peak_links | fail_runs | gates | score",
        profile.name
    );
    for s in scored {
        let gate_str = if s.passes_gates {
            "pass".to_string()
        } else {
            format!("fail({})", s.gate_failures.join(","))
        };
        println!(
            "{:>2}/{:<2} | {:>4} | {:>6.2}% | {:>7.1} | {:>8.3} | {:>10.2} | {:>13.3} | {:>11.1} | {:>10.1} | {:>9} | {:>20} | {:>8.5}",
            s.summary.max_connections,
            s.summary.satisfied_connections,
            s.summary.runs,
            s.summary.avg_success_rate * 100.0,
            s.summary.avg_p95_ms,
            s.summary.avg_overhead_ratio,
            s.summary.avg_component_count,
            s.summary.avg_largest_component_share,
            s.summary.avg_tick_p95_us,
            s.summary.avg_peak_connection_pairs,
            s.failed_runs,
            gate_str,
            s.score,
        );
    }
}

#[tokio::main]
async fn main() {
    let seeds = [11_u64, 22, 33, 44];
    let candidates = [(16_usize, 8_usize), (18, 9), (20, 10), (24, 12)];

    let mut configs = Vec::new();
    for (max_connections, satisfied_connections) in candidates {
        for seed in seeds {
            let reference_pool = PoolConfig {
                max_connections,
                satisfied_connections,
            };
            configs.push(SimConfig {
                node_count: 90,
                duration: Duration::from_secs(3),
                seed,
                // Fallback-only when strategy_mix is empty; keep aligned with reference.
                pool: reference_pool.clone(),
                discovery_interval_ms: 100,
                churn_rate: 0.02,
                allow_rejoin: true,
                network_latency_ms: 30,
                retrieval_probe_count: 20,
                retrieval_payload_bytes: 2048,
                retrieval_timeout_ms: 700,
                max_events_retained: 10_000,
                reference_strategy: Some("reference".to_string()),
                strategy_mix: vec![
                    NodeStrategyProfile {
                        name: "reference".to_string(),
                        weight: 35,
                        pool: reference_pool,
                    },
                    NodeStrategyProfile {
                        name: "conservative".to_string(),
                        weight: 35,
                        pool: PoolConfig {
                            max_connections: 12,
                            satisfied_connections: 6,
                        },
                    },
                    NodeStrategyProfile {
                        name: "aggressive".to_string(),
                        weight: 30,
                        pool: PoolConfig {
                            max_connections: 24,
                            satisfied_connections: 12,
                        },
                    },
                ],
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

    let mut summaries: Vec<Summary> = Vec::new();
    for (max_connections, satisfied_connections) in candidates {
        let mut success_sum = 0.0;
        let mut p95_sum = 0.0;
        let mut overhead_sum = 0.0;
        let mut component_sum = 0.0;
        let mut largest_share_sum = 0.0;
        let mut tick_p95_sum = 0.0;
        let mut peak_links_sum = 0.0;
        let mut run_success_rates = Vec::new();
        let mut run_largest_component_shares = Vec::new();
        let mut run_component_counts = Vec::new();
        let mut runs = 0_usize;

        for result in &results {
            if result.config.pool.max_connections != max_connections
                || result.config.pool.satisfied_connections != satisfied_connections
            {
                continue;
            }
            runs += 1;

            let reference = result
                .stats
                .strategy_retrieval
                .get("reference")
                .unwrap_or(&result.stats.retrieval);

            success_sum += reference.success_rate;
            p95_sum += reference.p95_latency_ms as f64;
            let overhead = if reference.payload_bytes == 0 {
                0.0
            } else {
                reference.data_plane_bytes as f64 / reference.payload_bytes as f64
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

            run_success_rates.push(reference.success_rate);
            run_largest_component_shares.push(largest_share);
            run_component_counts.push(result.final_topology.component_count as f64);
        }

        if runs == 0 {
            continue;
        }

        summaries.push(Summary {
            max_connections,
            satisfied_connections,
            runs,
            avg_success_rate: success_sum / runs as f64,
            avg_p95_ms: p95_sum / runs as f64,
            avg_overhead_ratio: overhead_sum / runs as f64,
            avg_component_count: component_sum / runs as f64,
            avg_largest_component_share: largest_share_sum / runs as f64,
            avg_tick_p95_us: tick_p95_sum / runs as f64,
            avg_peak_connection_pairs: peak_links_sum / runs as f64,
            run_success_rates,
            run_largest_component_shares,
            run_component_counts,
        });
    }

    let exploration = GateProfile {
        name: "exploration",
        min_success_rate: 0.70,
        min_largest_component_share: 0.80,
        max_component_count: 3.0,
        max_failed_runs: 1,
    };
    let promotion = GateProfile {
        name: "promotion",
        min_success_rate: 0.90,
        min_largest_component_share: 0.95,
        max_component_count: 2.0,
        max_failed_runs: 0,
    };

    print_ranked_for_profile(exploration, &summaries);
    print_ranked_for_profile(promotion, &summaries);
}
