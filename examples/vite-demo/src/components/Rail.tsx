/**
 * The builder's status strip.
 *
 * It used to carry the mark and the navigation too; both now live in the site
 * header above it, which is on every route. What is left is the part no header
 * can say -- which execution provider this tab actually got, and whether the
 * page is cross-origin isolated.
 */

export function Rail({ caps }: { caps: { label: string; on: boolean }[] }) {
    return (
        <header className="rail">
            <span className="rail__label">runtime</span>
            <div className="caps" role="status">
                {caps.map((cap) => (
                    <span className="cap" data-on={String(cap.on)} key={cap.label}>
                        {cap.label}
                    </span>
                ))}
            </div>
        </header>
    )
}
