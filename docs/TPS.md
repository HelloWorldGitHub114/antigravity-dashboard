# TPS timing quality

Desktop and IDE share the same calculation. Eligible output tokens matching the
measured streaming span are summed and divided by the sum of their streaming
durations. TTFT is separate; it is never added to the TPS denominator. No speed
ceiling or synthetic duration is used.

When a model finishes short thinking inside TTFT before the first visible token,
`responseOutputTokens` is paired with `streamingDuration`. When periodic thought
summaries or streamed thinking end TTFT early so remaining thinking streams inside
`streamingDuration` (`visible / duration < 0.85 × output / (ttft + duration)` or
zero visible tokens with positive thinking), sustained streams (`duration >= 15s`
or `duration >= max(2s, 2 × ttft)`) pair full `outputTokens` with `streamingDuration`,
while shorter split-boundary windows are quarantined as `token-scope`.

## Quarantined rates

- Invalid/inconsistent output token scopes, partial thought-summary boundary splits,
  or conflicting duplicate request records.
- Multiple attempt usage records with differing token counts, when the API supplies
  only one request timing summary. A single `retryInfos` item is not a retry.
- Tool-calling planner output (`toolCalls` present, with or without brief preamble
  text) with a stream under 5 seconds, TTFT at least 1 second, and TTFT at least
  12 times the streaming duration. Tool association requires the generator's step
  indices; no association is inferred from neighboring steps (except normalized
  remote snapshots).
- Short samples (`duration < 1s`) above `max(2.5 × median, median + 6 × MAD)` of
  at least two otherwise eligible samples lasting at least 1 second from the same
  model, provider and raw token basis. Different models never supply the baseline.
- Nonfinite calculated rates, or zero-token samples (treated as `missing`, never
  contributing duration with zero numerator).

Ordinary short text samples remain eligible and are flagged. Sustained high rates
remain eligible, even when above the baseline; they receive a warning. Thresholds
are deliberately conservative policy and may need real-world tuning.
No chunk timeline is exposed by the current Antigravity API, so the DSH `dt`
detector cannot be reproduced and actual server generation time cannot be recovered.

## Display and persistence

An unreliable latest request shows **Timing uncertain / 计时异常**, never the prior
request's rate. While a turn is actively generating (`CASCADE_RUN_STATUS_RUNNING`),
the latest request displays **Generating… / 计算中…** (or live streaming progress
`~XX.X tok/s` when streaming output tokens and duration are readable), cleanly
separating active in-flight execution from true post-completion anomalies. Prior
buffered tool windows quarantined during execution do not falsely flag active
turns as timing errors. Completed requests strictly retain exact measured TPS.
The UI keeps only the calculation basis; exclusion counts and
reasons remain numeric diagnostic metadata and are explained in the README. Tokens,
cache, context and TTFT are retained. If no eligible samples exist, TPS is unknown.

Old saved rates are masked until the full trajectory can be read and recalculated.
Other saved usage survives. Full coverage recalculations replace prior rates even
if fewer samples now qualify. Partial or regressing host responses do not replace
the saved full coverage snapshot. Only numeric aggregates and fixed reason codes
are saved; no prompts, output/tool arguments, request identifiers or raw trajectory
are added to persisted statistics.

References: DSH discussions
[7960](https://github.com/deepseek-ai/deepseek-harness/discussions/7960) and
[6129](https://github.com/deepseek-ai/deepseek-harness/discussions/6129).
