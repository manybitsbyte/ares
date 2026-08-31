# Findings from the first downstream consumer

Recorded 2026-08-13 by the first project to build against this ABI without also building the shim —
a browser player that instantiates the committed `.wasm`/`.mjs` artifacts and never reads ares source.
That vantage point is the value here: everything below is something the ABI's own surface either does
not say, or says in a way a consumer gets wrong on the first attempt.

None of these are defects in the port. Two are gaps in what the ABI reports; one is a documentation
correction. Nothing here is urgent and nothing blocks a consumer today — each is written so it can be
picked up standalone, later.

**Evidence.** Every number below was measured by a headless suite running the committed artifacts
across every resolution mode each core emits, 300 frames per core, six cores. Measurements are stated
as observed, not derived.

---

## 1. The ABI reports a sample count; a consumer needs a pixel geometry

`video_width` is a sample count. For every core but the Mega Drive it happens to equal a pixel count,
so a consumer that blits 1:1 is right five times out of six and wrong once — and the failure is
**silent**: the picture is simply too wide, with nothing raised.

The port's own `README.md` states the Mega Drive's 4:1 relationship, and the PC Engine's, so this is
documented. The finding is narrower: the relationship is documented **in prose, per core**, and a
consumer must therefore carry a hand-maintained per-core table that the ABI can neither supply nor
check. Add a core and the table is silently incomplete.

**Suggested shape, if this is ever worth closing:** two more exports alongside the existing dimension
queries — the horizontal and vertical sample-to-pixel divisors — so the geometry travels with the
module instead of with the reader's memory of the README. A consumer could then derive its own table
and assert it, which is exactly what cannot be done today.

### 1a. The Mega Drive's overscanned width is not a whole multiple of its own divisor

**This is the concrete instance, and the one worth a look.**

| core | overscanned width | documented divisor | quotient |
|---|---|---|---|
| md | **1415** | 4 | **353.75** |

Every un-overscanned Mega Drive width divides cleanly — 1280 → 320, and so on. The overscanned raster
does not. 1415 is odd, so no 4-sample-per-pixel reading of it can be whole.

A consumer computing a logical pixel size as `width / divisor` therefore gets a fractional width the
moment overscan is enabled, and has to invent a rounding rule the ABI never states. Which way to round
is not obvious and the two choices differ by a visible column.

**Only the Mega Drive is affected.** The Super Famicom's overscanned 564 ÷ 2 = 282 is whole; the
Famicom (283) and Master System (284) are one sample per pixel, which divides anything. An earlier
draft of this note claimed all four were affected — that was wrong and is corrected here.

**What is not established:** whether 1415 is correct hardware behaviour that a consumer must simply
handle, or an off-by-one in how the overscanned border is counted. Nothing was reproduced natively, so
this is an observation about the artifacts, not a defect claim. Reproducing it against a desktop build
is the first thing anyone picking this up should do.

## 2. Display aspect cannot be derived from this ABI, and is not exposed

The ABI reports framebuffer dimensions. Display aspect — 4:3 on a CRT console — is a fact about the
display, not about the frame, and no combination of the reported values yields it. A consumer must
hardcode it per core, from outside knowledge, with no way to check itself.

The two square-pixel handhelds are the exception that shows the rule: because their pixels are square,
their raster aspect *is* their display aspect, so a consumer can measure and verify 10:9 and 3:2. For
the four raster cores there is nothing to measure against — the declared 4:3 is an assertion the ABI
can neither confirm nor contradict.

This pairs naturally with finding 1: a pixel-geometry export would make display aspect derivable for
every core rather than only for the two where it is already trivially so.

## 3. Documentation correction — the Game Boy has no boot ROM, so header corruption does not lock up

A consumer's test suite carried an assumption, taken from desktop behaviour, that a Game Boy cartridge
with a corrupted Nintendo logo at `$0104` or a bad header checksum at `$014D` would fail the boot ROM's
validation and halt with a stable picture and silence.

**It does not, here.** This build runs with no boot ROM image, so that validation never executes. A
cartridge with both fields deliberately corrupted still ran: seven distinct pictures across the run and
audible output throughout.

Worth a line wherever the Game Boy port's behaviour is described, because it changes what a downstream
test can assume. The consumer-side assertion that catches a genuinely non-progressing machine — that
the picture is not constant across a run — remains correct and was confirmed to fail on a stalled
machine; only the stated *cause* is desktop-only.

---

## What is deliberately not here

Findings that belong to the consumer rather than to this ABI are recorded on the consumer's side, not
in this file. One example, so the boundary is clear: a redundant defensive copy in the consumer's own
save-state path, discovered by removing it and observing no failure. That is the consumer's code and
the consumer's problem.
