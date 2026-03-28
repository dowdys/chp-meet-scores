---
title: "feat: Cinematic Celebration Animation System"
type: feat
status: active
date: 2026-03-28
---

## Enhancement Summary

**Deepened on:** 2026-03-28
**Sections enhanced:** All major sections
**Review agents used:** architecture-strategist, performance-oracle, code-simplicity-reviewer, julik-frontend-races-reviewer, security-sentinel, kieran-typescript-reviewer, learnings-researcher (RLS + ordering system)

### Key Improvements from Deepening
1. **Removed `useAnimate`** — timeline is setTimeout-based, not imperative animation. Saves 2.3KB and eliminates scope race condition.
2. **Simplified phase model** — only one AnimatePresence boundary (intro -> reveal), not 4 phases. Phases 2-4 are staggered delays within a single mounted container.
3. **Added cancellation pattern** — AbortController-based delay for the async timeline, preventing state updates on unmounted components and duplicate onComplete calls.
4. **Replaced SVG feGaussianBlur with CSS radial-gradient** — feGaussianBlur is CPU-rasterized on mobile; radial-gradient is zero-cost.
5. **Inlined ReducedMotionCard** — not a separate file; 5-line conditional at top of overlay.
6. **Use sessionStorage instead of URL param** for replay prevention — handles back-button, skip, and re-scan.
7. **Added ChampionshipEvent type** to utils.ts with `event: GymEvent` and `score: number | null`.
8. **Identified ISR/COPPA concern** — ISR caches children's PII at CDN edges (out of scope but flagged as critical).
9. **Static imports for event animations** instead of 5 dynamic imports (eliminates 5 network round trips on 3G).

### Critical Issues Discovered
- **Race condition**: Async timeline has no cancellation; skip button causes duplicate onComplete
- **Crash**: `evt.score.toFixed(3)` throws on null scores (fix immediately, not in "polish")
- **Security**: ISR caching (revalidate=86400) persists minors' PII at CDN edges
- **RLS**: Client-side athlete_tokens query in /find will fail (confirmed by RLS learning doc)

---

# Cinematic Celebration Animation System

## Overview

Replace the current emoji-based placeholder celebration animations (bouncing gymnast emoji + trophy emoji with basic fade-in text) with a full-screen, cinematic SVG silhouette animation system. When a parent finds their athlete or scans their QR code, a 6-second choreographed celebration plays across 4 phases: event-specific SVG silhouette performance, podium rise with gold medal, confetti + name reveal, and CTA button. This is the "wow moment" that drives t-shirt purchases.

## Problem Statement / Motivation

The current celebration is underwhelming: all 5 event animations are nearly identical (emoji with spring-in), there's no skip button, no reduced-motion support beyond confetti, no full-screen overlay, and no phased choreography. Parents scanning QR codes at the gym see a basic emoji bounce and some text fading in. This doesn't create the emotional impact needed to drive conversion.

## Proposed Solution

Build a `CelebrationOverlay` component that **replaces** `CelebrationClient` (not wraps it). It manages a 2-stage full-screen animation (intro -> reveal) using LazyMotion + m components for minimal bundle size. Each event gets distinct SVG silhouette animations. The podium phase features a rising platform with golden glow. Confetti and name reveal use existing infrastructure. Skip is always available.

## Technical Approach

### Framer Motion Bundle Strategy

Use the lightweight `m` components — **every file must use `m`, not `motion`**. A single stray `import { motion }` pulls in the full ~34KB bundle and negates all savings.

```typescript
// LazyMotion provider (in overlay, single instance)
import { LazyMotion, domAnimation, AnimatePresence } from "framer-motion";
// Lightweight m components (in ALL animation files)
import { m } from "framer-motion";
// Reduced motion detection
import { useReducedMotion } from "framer-motion";
// NO useAnimate — not needed, timeline is setTimeout-based
```

**Bundle impact:**
| Import | Gzipped size |
|--------|-------------|
| `m` components (sync) | ~2.5KB |
| `domAnimation` features (async via LazyMotion) | ~10KB |
| canvas-confetti (existing, unchanged) | ~6KB |
| SVG paths + component logic | ~3-4KB |
| **Total** | **~22KB** (well under 50KB budget) |

### Research Insight: LazyMotion async loading
Load features asynchronously for maximum code splitting:
```typescript
<LazyMotion features={() => import("framer-motion").then(mod => mod.domAnimation)} strict>
```
The `strict` prop throws a runtime error if any child accidentally uses `motion.*` instead of `m.*`, catching bundle regressions during development.

### SVG Animation Strategy: Whole-Silhouette Crossfade + Translate

Each event has 3-4 complete SVG silhouette `<path>` elements (one per key athletic pose). Animation works by:

1. **Rapid crossfade** (200ms opacity transitions) between poses
2. **Container translation** (translateX/Y) moves the silhouette across the viewport
3. **Scale transitions** on key poses (e.g., flight phase slightly larger)

**Performance notes (from performance-oracle review):**
- ONLY animate `transform` and `opacity` — these are GPU-composited (Tier 1, always smooth)
- Do NOT animate `fill`, `stroke`, `height`, `width` — these trigger paint/layout
- Use `will-change: transform` on the 3-4 active animated elements only (not blanket)
- Framer Motion normalizes SVG `transform-origin` to element center by default
- For SVG attribute animations (`cx`, `cy`), use `attrX`/`attrY` Framer Motion props

### Phase Model (Simplified from Review)

The architecture review revealed that AnimatePresence only manages ONE transition (intro -> reveal). Phases 2-4 are staggered delays within a single mounted container. Renaming for clarity:

```
Stage 1: "Intro" (0-2s) — AnimatePresence key="intro"
├── Event-specific SVG silhouette cycles through 3-4 poses
├── Apparatus SVG visible as static background
├── Container translates to show movement across viewport
└── Gold sparkle particles during aerial phases

Stage 2: "Reveal" (2-6s) — AnimatePresence key="reveal"
├── [2.0s] Podium platform rises (translateY spring)
├── [2.3s] Standing silhouette on podium
├── [2.6s] Gold medal fades in + golden glow (CSS radial-gradient, NOT SVG feGaussianBlur)
├── [3.5s] ConfettiBurst fires
├── [3.7s] Athlete name reveals large + bold
├── [4.0s] Event titles with gold stars, staggered 0.15s each
├── [4.5s] "Level X . State . Year" badge
└── [5.0s] "Order Your Championship Shirt →" button fades up
```

### Research Insight: CSS radial-gradient > SVG feGaussianBlur
The performance-oracle review found that SVG `feGaussianBlur` is CPU-rasterized on mobile (5-15ms/frame on iPhone SE). Use CSS instead:
```css
.podium-glow {
  background: radial-gradient(
    ellipse at center,
    rgba(255, 215, 0, 0.3) 0%,
    rgba(255, 215, 0, 0.1) 40%,
    transparent 70%
  );
}
```
Zero rendering cost, identical visual result.

### Phase Orchestration: Cancelled Ref + Staggered Delays

**Critical fix from race conditions review** — the async timeline must be cancellable:

```typescript
useEffect(() => {
  const cancel = { cancelled: false };

  const timeline = async () => {
    setStage("intro");
    await cancellableDelay(2000, cancel);
    if (cancel.cancelled) return;
    setStage("reveal");
    await cancellableDelay(1500, cancel);
    if (cancel.cancelled) return;
    triggerConfetti();
    await cancellableDelay(2500, cancel);
    if (cancel.cancelled) return;
    onCompleteRef.current(); // use ref to avoid stale closure
  };
  timeline();
  return () => { cancel.cancelled = true; };
}, []);

// Skip button:
const handleSkip = () => {
  if (hasCompleted.current) return; // idempotent guard
  hasCompleted.current = true;
  cancel.cancelled = true;
  onComplete();
};
```

**Why not `useAnimate`?** The architecture review found that `useAnimate` adds 2.3KB for functionality we don't use — the timeline is purely `setTimeout`-based, not imperative animation. Removed from the plan.

### Research Insight: Schedule all timeouts from a single origin
To prevent drift accumulation, schedule all phase actions from the same base time:
```typescript
const phases = [
  { at: 0, action: () => setStage("intro") },
  { at: 2000, action: () => setStage("reveal") },
  { at: 3500, action: () => triggerConfetti() },
  { at: 6000, action: () => onCompleteRef.current() },
];
const timers = phases.map(({ at, action }) => setTimeout(action, at));
return () => timers.forEach(clearTimeout);
```
Each timer fires independently relative to the same origin — no accumulated drift.

### Replay Prevention: sessionStorage

**From race conditions review** — `sessionStorage` is better than a URL param:

```typescript
useEffect(() => {
  const key = `celebrated-${token}`;
  if (sessionStorage.getItem(key)) {
    setComplete(true); // skip animation, show static
    return;
  }
  sessionStorage.setItem(key, "1");
  // start timeline...
}, [token]);
```

- Handles back-button navigation (prevents replay in same tab)
- Allows replay in new tabs (parent sharing link)
- Doesn't pollute the URL

### Research Insight: Stale onComplete closure
The `onComplete` callback is captured at mount time in the `useEffect` closure. If it changes (parent re-renders), the stale version fires. Fix with a ref:
```typescript
const onCompleteRef = useRef(onComplete);
useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
```

---

## Architecture

### Component Hierarchy

```
CelebrationOverlay (REPLACES CelebrationClient — not a wrapper)
├── LazyMotion features={domAnimation} strict
│   ├── AnimatePresence mode="wait"
│   │   ├── key="intro": EventAnimation (statically imported based on primary event)
│   │   │   ├── Apparatus SVG (static, event-specific)
│   │   │   └── Silhouette poses (m.g + m.path, crossfade)
│   │   └── key="reveal": RevealStage
│   │       ├── PodiumReveal (podium + medal + glow)
│   │       ├── Name + events (staggered delays)
│   │       └── CTA button (appears last)
│   └── ConfettiBurst (triggers during reveal stage)
├── CelebrationErrorBoundary (catches dynamic import/render failures → static card)
├── Skip button (always visible, fixed position, 44x44px)
└── Inline reduced-motion conditional (NOT a separate component)
```

### Research Insight: Error Boundary (from architecture review)
A failed dynamic import or render error on the celebration page — the one page whose job is to make parents feel good — must never show a blank screen. Wrap the overlay in an error boundary that falls through to a static celebration card.

### Key Architectural Decision: Static Imports for Event Animations

**From performance-oracle review**: The current event animation components are ~500 bytes each. Five separate `next/dynamic` imports create 5 network round trips on 3G, which is worse than the bytes saved. Use static imports:

```typescript
import { VaultAnimation } from "@/components/celebration/vault-animation";
import { BarsAnimation } from "@/components/celebration/bars-animation";
// ...
```

This adds ~2KB total but eliminates 5 network requests and the race condition where animations aren't ready when Phase 1 starts.

**Exception**: If SVG animations grow large (>5KB each), reconsider dynamic imports with a loading gate:
```typescript
const [eventReady, setEventReady] = useState(false);
const EventAnimation = dynamic(() =>
  import(`@/components/celebration/${primaryEvent}-animation`)
    .then(m => { setEventReady(true); return m; }),
  { ssr: false, loading: () => <GoldShimmerPlaceholder /> }
);
// Don't start timeline until eventReady is true
```

---

## TypeScript Improvements

### Extract ChampionshipEvent type (from TypeScript review)

```typescript
// In website/src/lib/utils.ts
export interface ChampionshipEvent {
  event: GymEvent;
  score: number | null;  // null-safe (fixes Gap 15 crash)
  is_tie: boolean;
}
```

### Use string union for phase state

```typescript
type CelebrationStage = "intro" | "reveal";
const [stage, setStage] = useState<CelebrationStage>("intro");
```

### Type EVENT_ANIMATIONS with GymEvent key

```typescript
const EVENT_ANIMATIONS: Record<GymEvent, React.ComponentType<EventAnimationProps>> = {
  vault: VaultAnimation,
  bars: BarsAnimation,
  beam: BeamAnimation,
  floor: FloorAnimation,
  aa: AllAroundAnimation,
};
```

### Co-locate durations in a Record

```typescript
const EVENT_DURATIONS: Record<GymEvent, number> = {
  vault: 2000,
  bars: 2000,
  beam: 2000,
  floor: 2000,
  aa: 2000,
} as const;
```

### Add parseEvents validation at server/client boundary

```typescript
// In page.tsx — validate JSONB before passing to client component
function parseEvents(raw: unknown): ChampionshipEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ChampionshipEvent =>
      typeof e === "object" && e !== null &&
      "event" in e && "score" in e && "is_tie" in e
  );
}
```

---

## Implementation Phases

### Phase 1: Foundation (2 files)

- [ ] **Add `ChampionshipEvent` type to `website/src/lib/utils.ts`**
  - `event: GymEvent`, `score: number | null`, `is_tie: boolean`
  - Import in all components that use the events array

- [ ] **Create `website/src/components/celebration/celebration-overlay.tsx`**
  - **Replaces CelebrationClient** — rename or create new file
  - Full-screen overlay: `fixed inset-0 z-50` with dark radial gradient
  - `LazyMotion features={async domAnimation} strict` wrapping all children
  - `AnimatePresence mode="wait"` with two keys: "intro" and "reveal"
  - `useReducedMotion()` → inline conditional: static card if reduced motion
  - Cancelled ref + staggered delay timeline (NOT useAnimate)
  - Idempotent skip: `hasCompleted` ref prevents duplicate onComplete
  - Stale closure fix: `onCompleteRef` for the callback
  - SessionStorage replay prevention
  - Skip button: `<button aria-label="Skip celebration">`, 44x44px, bottom-center, Escape key
  - `role="dialog"`, `aria-modal="true"` on overlay
  - Scan tracking POST (fire-and-forget, moved from celebration-client.tsx)
  - Error boundary wrapper (catches render/import failures → static card)
  - Fix Gap 12: include `state` in orderUrl
  - Props: `{ token, athleteName, gym, level, state, meetName, events: ChampionshipEvent[], onComplete, orderUrl }`

### Phase 2: First Event Animation + Podium (2 files)

- [ ] **Replace `website/src/components/celebration/vault-animation.tsx`**
  - Use `m.svg`, `m.g`, `m.path` (NOT `motion.*`)
  - Apparatus SVG: vault table + runway
  - 4 silhouette poses as complete SVG `<path>` elements
  - Container translates left-to-right over 2s
  - Poses crossfade at 0s, 0.5s, 1.0s, 1.5s (200ms opacity transitions)
  - Gold sparkle particles during flight (3-4 `m.circle` elements)
  - Accept `isActive` prop

- [ ] **Replace `website/src/components/celebration/podium-reveal.tsx`**
  - Use `m.*` components (NOT `motion.*`)
  - Podium SVG: #1 platform in gold/amber, rises via translateY spring
  - Small standing silhouette on top
  - Gold medal SVG: circle + ribbon, fades in at neck
  - Golden glow: **CSS `radial-gradient`** (NOT SVG feGaussianBlur)
  - Athlete name: large bold text below podium
  - Events: gold stars (#FFD700) + event name + `score?.toFixed(3) ?? "---"` (null-safe!)
  - Handle empty events array gracefully (show name + gym only)
  - Level/State/Year badge: `bg-amber-900/30 text-amber-200`
  - Props: `{ athleteName, events: ChampionshipEvent[], level, state, gym }`

### Phase 3: Integration (1 file)

- [ ] **Update `website/src/app/celebrate/[token]/page.tsx`**
  - Import `CelebrationOverlay` instead of `CelebrationClient`
  - Add `parseEvents()` validation at server/client boundary
  - Pass validated events to client component

- [ ] **Fix confetti timer leak in `confetti-burst.tsx`**
  - Store the 300ms delayed burst timeout ID
  - Clear it in useEffect cleanup
  - Keep existing implementation otherwise (do NOT add useWorker complexity)

### Phase 4: Remaining Event Animations (4 files)

- [ ] **Replace `bars-animation.tsx`** — `m.*` only, apparatus SVG, 4 poses
- [ ] **Replace `beam-animation.tsx`** — `m.*` only, apparatus SVG, 4 poses
- [ ] **Replace `floor-animation.tsx`** — `m.*` only, corner markers, 4 poses, diagonal translate
- [ ] **Replace `all-around-animation.tsx`** — `m.*` only, gold fill (#FFD700), one pose per event

### Phase 5: Polish + Bug Fixes

- [ ] **Fix Gap 15**: Null-safe scores everywhere (already handled by `ChampionshipEvent` type)
- [ ] **Fix Gap 23**: In `/order/page.tsx`, skip inline celebration if `sessionStorage` has celebration key; add fade-out transition (opacity 0 over 500ms) instead of snap-removal
- [ ] **Focus management**: Move focus to CTA button when it appears
- [ ] **Build and test**: `cd website && npm run build`

---

## System-Wide Impact

### Interaction Graph

CelebrationOverlay **replaces** the composition in celebration-client.tsx. It internally composes:
- Event animations (static imports, selected by primary event)
- PodiumReveal (direct import within reveal stage)
- ConfettiBurst (direct import, fires during reveal stage)
- Error boundary (catches failures → static celebration card)

The `/order/page.tsx` still independently imports PodiumReveal — it will automatically get the new visual design. The inline celebration should check sessionStorage and skip if already celebrated.

### Error Propagation

- Render error in any animation → error boundary catches, shows static card
- `confetti.create()` failure → confetti doesn't fire, no error propagation
- `evt.score` null → handled by `ChampionshipEvent` type with `number | null`
- parseEvents validation catches malformed JSONB from Supabase

### State Lifecycle Risks

- All timers scheduled from single origin, cleaned up on unmount
- `cancel.cancelled` flag stops async timeline on unmount or skip
- `hasCompleted` ref prevents duplicate onComplete calls
- `onCompleteRef` prevents stale closure issues

### Migration Checklist: `motion` → `m` (from architecture review)

**Every file must be migrated.** A single stray `motion` import negates all LazyMotion savings.

- [ ] `podium-reveal.tsx` — `import { motion }` → `import { m }`
- [ ] `vault-animation.tsx` — same
- [ ] `bars-animation.tsx` — same
- [ ] `beam-animation.tsx` — same
- [ ] `floor-animation.tsx` — same
- [ ] `all-around-animation.tsx` — same
- [ ] Verify with `LazyMotion strict` — throws runtime error on `motion.*` usage

---

## Acceptance Criteria

### Functional Requirements

- [ ] Full-screen dark overlay renders on `/celebrate/[token]` page
- [ ] 2-stage animation plays (intro → reveal) with smooth AnimatePresence transition
- [ ] Each of 5 events has distinct SVG silhouette animation
- [ ] SVG silhouettes are artistic athletic forms (not emoji, not stick figures)
- [ ] Podium rises from below with gold medal and CSS golden glow
- [ ] Confetti burst fires during reveal stage with gold/white particles
- [ ] Athlete name, event titles with scores, and level/state badge display correctly
- [ ] CTA button links to order page with pre-filled athlete info (including state)
- [ ] Skip button always visible, functional (click + Escape key), idempotent
- [ ] Animation completes in 6 seconds or less
- [ ] Multiple events listed when athlete won more than one
- [ ] Co-champion badge shows for tied events
- [ ] All-around animation uses gold silhouette fill
- [ ] Replay prevented via sessionStorage (same tab only)
- [ ] Back-navigation shows static result, not replay

### Accessibility Requirements

- [ ] `prefers-reduced-motion` → static inline card (no animation, no separate component)
- [ ] Skip button: `aria-label`, 44x44px touch target, keyboard accessible
- [ ] Overlay: `role="dialog"`, `aria-modal="true"`
- [ ] Focus moves to CTA button when it appears
- [ ] Error boundary: render failures show static celebration card

### Performance Requirements

- [ ] Total animation JS under 50KB gzipped (~22KB estimated)
- [ ] Only GPU-composited properties animated (transform + opacity)
- [ ] `LazyMotion strict` mode enabled — catches accidental `motion.*` usage
- [ ] All files use `m.*` (NOT `motion.*`)
- [ ] CSS radial-gradient for golden glow (NOT SVG feGaussianBlur)
- [ ] Static imports for event animations (no 3G round-trip penalty)
- [ ] Confetti timer leak fixed (store + clear timeout ID)
- [ ] Reduced confetti particles on slow connections (existing behavior preserved)

### Mobile Requirements

- [ ] Works on 375px viewport width (iPhone SE)
- [ ] Touch-friendly skip button (44x44px minimum)
- [ ] No horizontal overflow or scroll during animation
- [ ] Landscape: content doesn't overflow viewport height

### Bug Fixes (discovered during analysis)

- [ ] `state` param included in order URL from QR path (Gap 12)
- [ ] `evt.score` null-safe via `ChampionshipEvent` type with `number | null` (Gap 15)
- [ ] Replay prevention via sessionStorage (Gaps 22, 27, 28)
- [ ] Inline celebration on order page checks sessionStorage and fades out (Gap 23)
- [ ] Confetti timer leak fixed (Race 8)
- [ ] parseEvents validates JSONB at server/client boundary
- [ ] Error boundary catches render failures

### Items NOT Included (simplicity review)

- [ ] ~~aria-live phase announcements~~ — removed; auto-advancing announcements confuse screen readers
- [ ] ~~Separate ReducedMotionCard file~~ — inlined as 5-line conditional
- [ ] ~~useAnimate from framer-motion/mini~~ — removed; timeline is setTimeout-based
- [ ] ~~confetti-burst.tsx useWorker refactor~~ — existing implementation works; just fix timer leak
- [ ] ~~`celebrated=1` URL param~~ — replaced with sessionStorage

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SVG silhouettes look amateurish | Medium | High | Start with clean, simple athletic forms. Ship vault first as proof of concept. Iterate. |
| A `motion.*` import sneaks in, negating bundle savings | Medium | High | `LazyMotion strict` mode throws runtime error. Also grep for `from "framer-motion"` without `m` in imports. |
| Animation jank on low-end phones | Low | Medium | Only animate transform + opacity. CSS radial-gradient for glow. No SVG filters. |
| Phase timing feels off | Medium | Low | Timer values are tunable constants. Schedule from single origin. |
| Dynamic import fails on 3G | Low | Low | Static imports eliminate this risk. Error boundary as fallback. |
| Back-button replays animation | Low | Low | sessionStorage prevents replay in same tab. |

---

## Security Concerns (from security-sentinel review)

**Out of scope for this feature but flagged as critical for follow-up:**

| # | Finding | Severity | Recommendation |
|---|---------|----------|---------------|
| 1 | ISR (revalidate=86400) caches children's PII at CDN edges | CRITICAL | Change to `force-dynamic` or cache only the shell |
| 2 | Order page trusts URL params without server validation | HIGH | Validate (name, gym, meet, level) against `winners` table before Stripe session |
| 3 | Client-side `athlete_tokens` query bypasses/fails RLS | HIGH | Move to server-side API route (confirmed by RLS learning doc) |
| 4 | `/api/celebrate` has no rate limiting | MEDIUM | Add 10 req/IP/min rate limit |
| 5 | Token enumeration via response differentiation | MEDIUM | Return same page structure for valid/invalid tokens |

These should be tracked as separate issues. The celebration animation work should not be blocked by them, but they are real risks.

---

## Future Considerations

- **Order page upgrade**: Replace inline celebration with `CelebrationOverlay variant="inline"` (abbreviated 3-second version)
- **Sound effects**: Optional subtle sound on confetti burst (muted by default)
- **Share button**: Let parents share a screenshot/link of the celebration
- **Path morphing**: Upgrade from crossfade to SVG path morphing between poses (more fluid but requires matching point counts)
- **Drop framer-motion entirely**: Performance oracle notes that every animation here is achievable with pure CSS `@keyframes` + `animation-delay` for 0KB JS. Consider if bundle becomes a concern.

## Sources & References

### Internal References
- Current celebration client: `website/src/app/celebrate/[token]/celebration-client.tsx`
- Current event animations: `website/src/components/celebration/*.tsx`
- Event display names: `website/src/lib/utils.ts:47` (EVENT_DISPLAY)
- SVG precedent (shirt silhouette): `website/src/components/shirt-preview.tsx:27-48`
- RLS learning: `docs/solutions/database-issues/supabase-rls-using-true-is-not-service-role-only.md`
- Ordering system architecture: `docs/solutions/ORDERING-SYSTEM-ARCHITECTURE.md`

### External References
- Framer Motion LazyMotion docs: https://motion.dev/docs/react-lazy-motion
- Framer Motion bundle reduction: https://motion.dev/docs/react-reduce-bundle-size
- Framer Motion SVG animation: https://motion.dev/docs/react-svg-animation
- Framer Motion accessibility: https://motion.dev/docs/react-accessibility
- Animation performance tiers: https://motion.dev/magazine/web-animation-performance-tier-list
- canvas-confetti API: https://github.com/catdad/canvas-confetti

### Key Technical Notes
- `domAnimation` (~10KB gzipped deferred) includes AnimatePresence; `domMax` only for drag/layout
- `LazyMotion strict` throws error on accidental `motion.*` usage — essential for bundle protection
- Framer Motion normalizes SVG transform-origin to element center (unlike raw SVG)
- CSS `filter: blur()` is GPU-composited; SVG `feGaussianBlur` is CPU-rasterized on mobile
- `AnimatePresence mode="wait"` exits old before entering new; use `easeIn` on exit + `easeOut` on enter
- canvas-confetti's delayed burst setTimeout must be stored and cleared on unmount
- `sessionStorage` (not `localStorage`) prevents same-tab replay while allowing new-tab replay
