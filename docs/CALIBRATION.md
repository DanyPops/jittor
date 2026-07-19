# Jittor routing calibration and rollback

Verified locally on 2026-07-19 without logging provider credentials or raw usage values.

## Live dogfood result

The supervised daemon successfully:

- loaded explicitly configured private Codex file credentials;
- polled the experimental ChatGPT Codex usage contract;
- polled the official OpenRouter key endpoint;
- persisted normalized observations through the daemon-owned SQLite store;
- reported both sources fresh and the router ready;
- calculated a deterministic policy decision for the active Pi route;
- exposed status through authenticated operations and the Pi footer/panel.

The live Codex response exposed one default window and one additional metered limit. The OpenRouter key exposed spend telemetry but no configured per-key limit, so OpenRouter contributes raw USD status and response cost accounting but does not yet create a resettable pressure window. Jittor does not invent an OpenRouter budget.

## Pressure model

For each resettable window:

```text
observed burn     = delta(used fraction) / delta(time)
                 or average used fraction / elapsed window time
sustainable burn = remaining fraction / time until reset
pressure          = observed burn / sustainable burn
```

The highest-pressure fresh required window binds the decision. Provider percentage and observed Pi token velocity remain separate metrics.

## Initial thresholds

| Pressure | Decision |
|---:|---|
| `<= 1.00` | continue |
| `> 1.00` | throttle, up to 30 seconds |
| `> 1.25` | lower thinking |
| `> 1.50` | switch to a cheaper model on the same provider |
| `> 2.00` | switch provider |
| `> 3.00` | halt |

A consumed fraction of 99% is an unconditional hard stop. Missing, failed, older-than-120-second, impossible, or low-confidence required telemetry also halts before a provider request.

Recovery uses 10% hysteresis and a five-minute cooldown. Escalation is immediate; recovery waits, preventing route oscillation around a threshold.

## Route ladder

The default tested route order is:

1. `openai-codex/gpt-5.6-sol · high`
2. `openai-codex/gpt-5.6-sol · medium`
3. `openai-codex/gpt-5.3-codex · high`
4. `openai-codex/gpt-5.3-codex · medium`
5. `openai-codex/gpt-5.1-codex-mini · medium`
6. `openrouter/openai/gpt-4.1-mini · medium`

The Pi extension reports the actual selected model and thinking level back to the daemon before policy evaluation. Missing or unauthenticated routes escalate to the next safe stage and ultimately halt.

## User controls

- Footer status: Codex longest-window percentage, raw OpenRouter spend, and current decision.
- `/jittor`: provider windows, observed/sustainable burn, pressure, current route, next downgrade, freshness, and controls.
- Pause/resume and route overrides require confirmation.
- Overrides expire after one hour unless cleared earlier.

Pause is a safety halt, not a bypass. It intentionally blocks subsequent provider requests.

## Scenario coverage

`test/calibration.test.ts` verifies:

- sustainable continuation;
- throttling;
- thinking downgrade;
- same-provider model handoff;
- provider handoff;
- stale-telemetry fail-closed behavior;
- pressure and utilization hard halts;
- cooldown/hysteresis route retention.

Extension tests verify pre-request blocking, model/thinking actuation, response-header ingestion, finalized usage recording, and footer formatting.

## Rollback

To remove enforcement without creating a fail-closed outage:

1. Remove or disable the local Jittor Pi package, then reload Pi:
   ```bash
   pi remove /home/dpopsuev/Projects/jittor
   ```
2. Stop and disable the daemon only after the extension is unloaded:
   ```bash
   systemctl --user disable --now jittor.service
   ```

Stopping the daemon while the extension remains loaded intentionally blocks provider requests. To restore:

```bash
cd /home/dpopsuev/Projects/jittor
bun src/cli.ts service install
pi install /home/dpopsuev/Projects/jittor
```

Then reload Pi and run `/jittor` to confirm both readiness and provider freshness.
