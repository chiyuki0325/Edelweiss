# Content-Aware Frame Selection: Exploration Notes

> Status: **Explored & deferred.** Equidistant sampling retained as default for short animations.
> Date: 2026-04-09

## Motivation

Equidistant frame sampling for animation-to-text can miss key transitions — a sticker with one brief action surrounded by static poses may yield N nearly-identical frames. The idea was to replace equidistant sampling with MSE-based selection that picks the most visually distinct frames.

## Implemented Approach (MSE-based)

A pure module (`frame-selector.ts`) was built with no I/O dependencies:

```ts
computeMse(a: Buffer, b: Buffer): number     // pixel-level MSE
selectKeyFrameIndices(pixels: Buffer[], maxFrames: number): number[]
```

**Strategy:**
1. Extract ALL frames at 64×64 grayscale as a preview pass (~5ms/frame for TGS, single ffmpeg pass for video)
2. Compute MSE between each consecutive frame pair → change curve
3. Pick the `(maxFrames - 1)` highest-change transitions as segment boundaries
4. Boundaries divide the sequence into segments; pick the middle frame of each segment
5. Full-res pass: extract only the selected frames at 512px

When total frames > 60, a pre-sample of 60 equidistant candidates bounded the preview pass cost.

**Fallback:** When all MSE ≈ 0 (static content), boundaries are arbitrary → degenerates to equidistant-like spacing.

## Observed Problems

### Boundary clustering

When all consecutive frames have high MSE (fast/continuous motion — common in screen recordings, fast-panning memes), the top-N transitions are near-random. The 4 boundaries can cluster in one area, producing segments like `[0-2], [3], [4], [5], [6-59]` — far worse than equidistant.

### Static segment waste

If the animation is "static → brief action → static" (common for expression stickers), the algorithm correctly finds the transition boundaries but the resulting static segments all produce identical-looking frames. Two of five frames are wasted showing the same pose.

### Diminishing returns for short content

For 1-3 second animations (20-90 frames), 5 equidistant frames already provide ~0.3-0.6s temporal resolution — sufficient to capture most actions. Content-aware selection adds latency (preview pass) and code complexity without meaningful improvement at this scale.

## Research Survey (April 2026)

### Open-Source IM Chatbot Projects

| Project | Strategy | Details |
|---------|----------|---------|
| OpenClaw | Whole-video passthrough | base64 encode entire file → Gemini/Qwen/Moonshot native video API |
| MaiBot | MSE sequential dedup | Compare each frame to *last selected* frame, select if MSE > 1000, max 15 frames, concat into sprite strip |
| proj-airi (Telegram) | Equidistant subsampling | ffmpeg 15fps → if >8 frames, pick every Nth → per-frame VLM then text consolidation |
| ChatLuna | Configurable | first-frame / first-N / equidistant-N |
| Popular ChatGPT TG bots | None | Reject video or extract audio only |

### Academic / Official Guidance

| Source | Strategy | Frame Count |
|--------|----------|-------------|
| OpenAI Cookbook | Equidistant (every Nth or 1fps) | ~25 or 1/sec |
| Google Gemini | Native video API, internal 1fps | Automatic |
| Anthropic Claude | No video; GIF = first frame only | ≤600 images |
| Video-ChatGPT (ACL 2024) | Segment-middle (divide into N segments, pick middle) | 100 |
| Video-LLaVA (EMNLP 2024) | `np.linspace` equidistant | 8 |
| VideoChat2 (CVPR 2024) | rand/middle/fps, with timestamp injection | 4-8 |
| ShareGPT4Video | CLIP semantic similarity keyframes | Dynamic |
| AKS (CVPR 2025) | Adaptive: relevance + coverage optimization | Dynamic |
| LLaVA-Video | Equidistant, tested 32→110 frames | 32-110 |

### Key Findings

1. **Equidistant is the industry default.** From OpenAI to Gemini to research labs, the overwhelming majority use fixed-interval sampling.
2. **Content-aware yields marginal gains (1-3% on benchmarks)** and adds complexity. AKS (CVPR 2025) is hard to reproduce and sensitive to hyperparameters.
3. **Frame count matters more than per-frame quality** (LLaVA-Video: 110 frames low-token > 32 frames high-token).
4. **MaiBot's sequential MSE dedup** is the closest practical approach to content-aware selection in the chatbot space — simpler than our top-N approach but still threshold-dependent.
5. **Timestamp annotation is consensus** — VideoChat2 and OpenAI both recommend labeling frame times in prompts.

## Alternative Approaches Considered But Not Implemented

### Cumulative MSE budget splitting
Accumulate MSE along timeline, cut when cumulative reaches `totalMSE / maxFrames`. Avoids boundary clustering, degrades gracefully to equidistant for static content. Better than top-N peaks but still over-engineers the problem for short animations.

### Greedy farthest-point sampling
Start with frame 0, iteratively pick the frame with maximum MSE distance to all selected frames. Guarantees diversity but ignores temporal ordering.

### CLIP/BLIP semantic keyframes
Use a vision encoder to find semantically distinct frames (ShareGPT4Video approach). Too expensive for our use case — would add a model inference per preview frame.

### Frequency-domain smoothing
Low-pass filter the MSE curve to suppress frame-to-frame jitter, then find peaks. Equivalent to moving-average smoothing — adds complexity without clear benefit for short content.

## Decision

**Retain equidistant sampling** with existing `deduplicateFrames` (hash-based exact dedup, used for static sticker detection). The added `frameTimestamps` feature is kept regardless of sampling strategy.

Content-aware selection should be revisited if/when the system needs to handle **long-form video** (minutes+), where equidistant sampling genuinely wastes frames on static segments.
