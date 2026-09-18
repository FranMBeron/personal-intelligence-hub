import { publicConfig } from "../config/public";
import { getApiHealth } from "../lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const apiHealth = await getApiHealth();

  return (
    <section aria-labelledby="home-title">
      <h1 id="home-title">{publicConfig.productName}</h1>
      <p role="status" aria-live="polite">
        API status: {apiHealth}
      </p>
    </section>
  );
}
