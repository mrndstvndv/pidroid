// Motion: Material 3 Expressive springs, for the Web Animations API.
//
// M3 Expressive moves things with springs rather than fixed curves. Its motion scheme has
// two kinds:
//  - spatial: for things that move or resize. These may overshoot a little, which is the bounce
//    the expressive scheme is known for.
//  - effects: for opacity and colour. These never overshoot.
// Each kind comes in fast, default and slow. The values are damping ratio and stiffness at unit
// mass, as in Compose's MotionScheme.expressive(). A spring has no fixed duration or easing,
// so each one is solved once here into a CSS linear() easing plus the time it takes to settle.
// Element.animate() can then play it like any other animation.
(() => {
  const SPRINGS = {
    spatialFast: { damping: 0.6, stiffness: 800 },
    spatialDefault: { damping: 0.8, stiffness: 380 },
    spatialSlow: { damping: 0.8, stiffness: 200 },
    effectsFast: { damping: 1, stiffness: 3800 },
    effectsDefault: { damping: 1, stiffness: 1600 },
    effectsSlow: { damping: 1, stiffness: 800 },
    // Text arriving under a reader who follows the tail. Critically damped, so the text never
    // bounces: an overshoot would read as the line landing twice.
    follow: { damping: 1, stiffness: 520 },
  };

  /** Position of a spring released at 0 towards 1, at time t (seconds). */
  function position({ damping, stiffness }, t) {
    const w = Math.sqrt(stiffness);
    if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
    const wd = w * Math.sqrt(1 - damping * damping);
    const decay = Math.exp(-damping * w * t);
    return 1 - decay * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
  }

  /** When the spring is within a thousandth of rest and stays there. */
  function settleTime(spring) {
    const w = Math.sqrt(spring.stiffness);
    const zw = Math.min(spring.damping, 1) * w;
    // The envelope bounds every later swing, so once it is small enough the motion is done.
    let t = 0;
    while (t < 3 && Math.exp(-zw * t) * (1 + w * t) > 0.001) t += 0.005;
    return t;
  }

  const supportsLinear = (() => {
    try { return CSS.supports("animation-timing-function", "linear(0, 1)"); } catch { return false; }
  })();
  const solved = {};

  /** {duration (ms), easing} for a named spring. Browsers without linear() get a close cubic. */
  function spring(name) {
    if (solved[name]) return solved[name];
    const s = SPRINGS[name];
    const seconds = settleTime(s);
    let easing = "cubic-bezier(0.2, 0, 0, 1)"; // M3's emphasized decelerate, the nearest fixed curve
    if (supportsLinear) {
      const steps = 48;
      const points = [];
      for (let i = 0; i <= steps; i++) points.push(+position(s, (seconds * i) / steps).toFixed(4));
      points[steps] = 1;
      easing = `linear(${points.join(", ")})`;
    }
    return (solved[name] = { duration: Math.round(seconds * 1000), easing });
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Element.animate with a named spring. Returns the Animation, or null when motion is reduced (or
   *  unsupported), in which case the caller just applies the end state. The end state is held
   *  until the caller cancels it, so a page can swap a hidden attribute or a class underneath first. */
  function play(el, keyframes, name) {
    if (!el || reduce.matches || !el.animate) return null;
    const { duration, easing } = spring(name);
    return el.animate(keyframes, { duration, easing, fill: "forwards" });
  }

  window.M3Motion = { spring, play, SPRINGS };
})();
