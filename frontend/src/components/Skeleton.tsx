/** Quiet placeholders shown while data loads (no layout jump when the real content arrives). */
export function SkeletonRows({ n = 3 }: { n?: number }) {
  return <div aria-hidden>{Array.from({ length: n }, (_, i) => (
    <div key={i} className="skel-row"><span className="skel" style={{ width: 36, height: 36 }} /><div className="grow"><span className="skel" style={{ width: `${55 - i * 7}%`, height: 14 }} /><span className="skel" style={{ width: "30%", height: 11, marginTop: 8 }} /></div><span className="skel" style={{ width: 84, height: 26 }} /></div>
  ))}</div>;
}
export const SkeletonKpis = () => <div className="kpis" aria-hidden>{[0, 1, 2, 3].map((i) => <span key={i} className="skel skel-kpi" />)}</div>;
