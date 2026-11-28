import styles from "./Scan.module.css";

// Parallel sections of one twisted ribbon. Cubic curves keep the drawing small at any resolution.
function contour(depth: number) {
  const bow = Math.sin(Math.PI * depth);
  return [
    `M -240 ${226 - 76 * depth}`,
    `C 5 ${230 - 38 * depth} 112 ${10 + 18 * depth} 310 ${88 + 172 * depth}`,
    `S 550 ${324 - 215 * depth} 735 ${Math.round(178 - 82 * depth - 38 * bow)}`,
    `S 1000 ${-90 + 332 * depth} 1240 ${128 + 84 * depth}`,
    `S 1410 ${213 - 58 * depth} 1520 138`,
  ].join(" ");
}

const mesh = Array.from({ length: 41 }, (_, index) => contour(index / 40)).join(" ");
const signals = [0, 0.3, 0.7, 1].map(contour);

export function ScanField() {
  return (
    <div className={styles.field}>
      <svg aria-hidden="true" viewBox="0 0 1280 320" preserveAspectRatio="none" fill="none">
        <g className={styles.ribbon}>
          <path d={mesh} className={styles.mesh} />
          {signals.map((d) => <path key={d} d={d} pathLength="100" className={styles.signal} />)}
        </g>
      </svg>
    </div>
  );
}
