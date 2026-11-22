export function InstallPanel({ id }: { id: string }) {
  return (
    <section className="mt-10" aria-labelledby="install-heading">
      <h2 id="install-heading" className="text-xl font-semibold">Put this agent on your site</h2>
      <p className="mt-2">Download a copy that runs on your own website.</p>
      <a className="mt-3 inline-block font-medium underline" href={`/p/${id}/bundle.zip`} download>Download the files</a>
      <p className="mt-2 text-sm" style={{ color: "var(--color-muted)" }}>
        For a site you own. Unzip, copy the contents of the <code>site</code> folder to your web root, then open <code>/assistant/</code>. The README has the details.
      </p>
    </section>
  );
}
