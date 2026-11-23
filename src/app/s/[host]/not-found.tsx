import { SitePage } from "@/components/SitePage";
import { PUBLISHED_PAGE_TEXT as T } from "@/lib/site/publish-texts";

export default function PublishedNotFound() {
  return (
    <SitePage title={T.notFoundTitle}>
      <p className="mt-4">{T.notFound}</p>
      <p className="mt-6">
        <a href="/" className="underline">
          {T.analyze}
        </a>
      </p>
    </SitePage>
  );
}
