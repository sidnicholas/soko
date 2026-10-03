/**
 * Services are supply too (AIOOS §8): what the user can sell directly. A
 * business problem matched to one of these has the clearest compensation path
 * (a service fee paid by the business with the problem).
 */
export interface ServiceOffering {
  key: string;
  name: string;
  /** What the problem looks like from the outside — fed to detection and matching. */
  signals: string[];
  /** Typical fee range for a first engagement, USD (an estimate, labelled as such). */
  typicalFeeUsd: [number, number];
}

export const SERVICES: readonly ServiceOffering[] = [
  {
    key: "analytics_tracking",
    name: "GA4 / Google Tag Manager tracking repair and implementation",
    signals: ["GA4 not tracking", "conversions not recording", "GTM tags not firing", "pixel not tracking purchases", "ad spend with no attribution"],
    typicalFeeUsd: [300, 1500],
  },
  {
    key: "website_repair",
    name: "Website repair (WordPress / Divi / WooCommerce)",
    signals: ["site down", "white screen", "broken after update", "hacked site", "checkout not working", "contact form not sending"],
    typicalFeeUsd: [200, 1200],
  },
  {
    key: "conversion_optimization",
    name: "Conversion-rate and lead-funnel optimization",
    signals: ["traffic but no sales", "leads dropped", "high cart abandonment", "landing page not converting"],
    typicalFeeUsd: [500, 3000],
  },
  {
    key: "sourcing",
    name: "Sourcing and procurement research (find suppliers / inventory)",
    signals: ["can't find supplier", "backordered", "discontinued part", "need a vendor", "sources sought"],
    typicalFeeUsd: [250, 2500],
  },
  {
    key: "automation",
    name: "Workflow automation and integrations",
    signals: ["manual data entry", "systems don't talk", "zapier broken", "spreadsheet chaos"],
    typicalFeeUsd: [400, 2500],
  },
  {
    key: "research_coordination",
    name: "Research, coordination and project management",
    signals: ["project stalled", "need someone to coordinate", "vendor management", "need research done"],
    typicalFeeUsd: [300, 2000],
  },
];

export function serviceByKey(key: string | null | undefined): ServiceOffering | undefined {
  return SERVICES.find((s) => s.key === key);
}
