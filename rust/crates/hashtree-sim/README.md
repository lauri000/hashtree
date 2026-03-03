# hashtree-sim

P2P network simulation for hashtree, testing routing strategies and network behavior.

## Recommended: webrtc_sim

The `webrtc_sim` module uses the **exact same code** as production WebRTCStore,
just with mock transports. This is the recommended approach for testing:

```rust
use hashtree_sim::webrtc_sim::{Simulation, SimConfig};

let config = SimConfig {
    node_count: 100,
    pool: PoolConfig { max_connections: 16, satisfied_connections: 8 },
    retrieval_probe_count: 200,
    retrieval_payload_bytes: 4096,
    retrieval_timeout_ms: 1500,
    max_events_retained: 20_000,
    ..Default::default()
};

let sim = Simulation::new(config);
sim.run().await;
let report = sim.report_json().await;
println!("{}", serde_json::to_string_pretty(&report).unwrap());
```

## Shared Code with Production

The simulation uses the **same types and defaults as production WebRTC**:

```rust
// Uses hashtree_webrtc::PoolConfig - same defaults as real WebRTC
let config = SimConfig {
    pool: PoolConfig::default(),  // max_connections: 16, satisfied_connections: 8
    ..Default::default()
};
```

This ensures simulation behavior matches production as closely as possible.

## Parameter Sweeps

Use `run_parameter_sweep` to compare protocol settings across seeds or policies:

```rust
use hashtree_sim::{run_parameter_sweep, SimConfig, PoolConfig};

let configs = vec![
    SimConfig {
        seed: 1,
        pool: PoolConfig { max_connections: 8, satisfied_connections: 4 },
        retrieval_probe_count: 100,
        ..Default::default()
    },
    SimConfig {
        seed: 2,
        pool: PoolConfig { max_connections: 12, satisfied_connections: 6 },
        retrieval_probe_count: 100,
        ..Default::default()
    },
];

let results = run_parameter_sweep(&configs).await;
for result in results {
    println!(
        "seed={} success_rate={:.2}% p95={}ms components={} local_tick_p95_us={} peak_links={}",
        result.config.seed,
        result.stats.retrieval.success_rate * 100.0,
        result.stats.retrieval.p95_latency_ms,
        result.final_topology.component_count,
        result.stats.local_resources.tick_p95_us,
        result.stats.local_resources.peak_connection_pairs
    );
}
```

### Local Resource Objectives

`report_json()` now includes local efficiency objectives so sweeps can optimize beyond retrieval quality:
- `local_cpu_tick_p95_us`
- `local_cpu_run_wall_ms`
- `local_mem_peak_event_log_entries`
- `local_mem_peak_connection_pairs`
- `reference_success_rate` / `reference_p95_latency_ms` / `reference_failure_rate`

### Mixed Strategy Simulation

`SimConfig` supports heterogeneous node behavior via `strategy_mix` and `reference_strategy`.
This lets sweeps evaluate one candidate strategy inside a network of mixed incentives.

```rust
use hashtree_sim::{NodeStrategyProfile, PoolConfig, SimConfig};

let config = SimConfig {
    reference_strategy: Some("reference".to_string()),
    strategy_mix: vec![
        NodeStrategyProfile {
            name: "reference".to_string(),
            weight: 35,
            pool: PoolConfig { max_connections: 18, satisfied_connections: 9 },
        },
        NodeStrategyProfile {
            name: "aggressive".to_string(),
            weight: 30,
            pool: PoolConfig { max_connections: 24, satisfied_connections: 12 },
        },
        NodeStrategyProfile {
            name: "conservative".to_string(),
            weight: 35,
            pool: PoolConfig { max_connections: 12, satisfied_connections: 6 },
        },
    ],
    ..Default::default()
};
```

The tuning example evaluates two gate profiles:
- `exploration`: coarse filter for short/fast sweeps
- `promotion`: stricter thresholds for candidates considered production-ready
- both profiles hard-gate on per-run failures (not just averages)

## Network Connectivity

### The Component Problem

In P2P networks, nodes may form disconnected "components" (islands) if there aren't enough connections. A fully connected network has exactly 1 component.

**Graph theory**: For N nodes with k connections each, connectivity requires `k > ln(N)`:

| Nodes | ln(N) | Real WebRTC default (16) |
|-------|-------|--------------------------|
| 50    | 3.9   | Well connected           |
| 100   | 4.6   | Well connected           |
| 200   | 5.3   | Well connected           |
| 1000  | 6.9   | Well connected           |
| 10000 | 9.2   | Edge case                |

The tuned default `max_connections: 16` keeps stronger connectivity under churn while keeping overhead moderate.

### Discovery with Perfect Negotiation

Nodes discover each other via Hello messages on a mock relay. We use the WebRTC **"perfect negotiation"** pattern:

1. When a node sees a Hello and NEEDS more peers (below `satisfied_connections`), it sends an offer
2. Both peers may send offers simultaneously - this is expected, not an error
3. On collision (both sent offers), the **"polite" peer** (lower ID) backs off and accepts the incoming offer
4. The **"impolite" peer** (higher ID) ignores the incoming offer and waits for their answer

```rust
// Polite peer backs off on collision
fn is_polite_peer(local_id: &str, remote_id: &str) -> bool {
    local_id < remote_id  // Lower ID is polite
}
```

**Why perfect negotiation?** With simple tie-breaking, if peer A is "satisfied" and peer B needs connections, B might not be able to connect if A was supposed to initiate. Perfect negotiation solves this: B sends an offer, A accepts it (since A can still accept up to `max_connections`).

## Routing Strategies

### Flooding
- Sends requests to ALL connected peers simultaneously
- First response wins
- High bandwidth, low latency
- Good for small networks or when speed is critical

### Adaptive
- Tries peers sequentially, ordered by past performance
- Learns which peers have data and respond quickly
- Low bandwidth, slightly higher latency
- Uses exponential backoff for slow/unreliable peers

## Latency Simulation

Per-link latency is configurable:
- `network_latency_ms`: Mean latency (e.g., 50ms for realistic WebRTC)
- `latency_variation`: How much latency varies per link (0.0-1.0)
- `latency_seed`: Seed for reproducible latency distribution

Each link gets a fixed latency drawn from a distribution centered on `network_latency_ms`.

## Multi-Hop Forwarding (HTL)

Requests include a **Hops-To-Live** counter (like Freenet):
- Starts at MAX_HTL (10)
- Decremented at each hop (with probabilistic variation per-peer)
- When HTL=0, request is not forwarded further
- Prevents infinite loops and limits network load

## Running Simulations

```bash
# Basic simulation
cargo run --example run_simulation

# With options
cargo run --example run_simulation -- \
  --nodes 200 \
  --strategy adaptive \
  --latency 50 \
  --seed 42

# Benchmark mode (measures throughput)
cargo run --example run_simulation -- --bench --nodes 100

# Burst benchmark (realistic load)
cargo run --example run_simulation -- --burst --nodes 50

# Multiple runs for variance analysis
cargo run --example run_simulation -- --bench --runs 5
```

## Key Learnings

1. **max_peers matters**: Too low (< ln(N)) causes network fragmentation
2. **Adaptive beats Flooding** for bandwidth efficiency once it learns peer quality
3. **Latency variation** is important - uniform latency is unrealistic
4. **Multi-hop forwarding** dramatically increases reach but adds latency
5. **Perfect negotiation beats simple tie-breaking**: With simple "lower ID initiates" tie-breaking, satisfied nodes don't initiate, leaving unsatisfied nodes unable to connect to them. Perfect negotiation (both sides can send offers, collisions resolved by polite/impolite) solves this by letting unsatisfied nodes reach satisfied-but-not-full nodes.
6. **Use same code for simulation**: Using the exact same signaling code as production ensures simulation behavior matches reality. The `webrtc_sim` module does this.
