/**
 * Generates a random, realistic inbound lead for the "Simulate lead" demo button.
 * Template-based (no LLM call) so it's free, instant and can't be abused to spend tokens.
 * Contact details use the reserved `.example` TLD so nothing can ever reach a real inbox.
 */

export type SimulatedLead = {
  profile: "fit" | "needs_info" | "poor_fit" | "spam" | "fit_non_english";
  name: string;
  email: string;
  company: string;
  website: string | null;
  message: string;
};

type Rng = () => number;

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 20);

const FIRST = [
  "Emma",
  "Noah",
  "Ava",
  "Lucas",
  "Mia",
  "Ethan",
  "Chloe",
  "Leo",
  "Grace",
  "Omar",
  "Nina",
  "Jonas",
  "Aisha",
  "Mateo",
  "Hannah",
  "Kenji",
];
const LAST = [
  "Carter",
  "Nguyen",
  "Schmidt",
  "Rossi",
  "Okafor",
  "Silva",
  "Kowalski",
  "Haddad",
  "Lindqvist",
  "Patel",
  "Moreau",
  "Tanaka",
  "Brennan",
  "Yilmaz",
];

const B2B = [
  {
    industry: "logistics company",
    company: ["Northstar Freight", "BlueRoute Logistics", "CargoMint"],
    size: [60, 250],
    pain: "we re-type shipment requests from emails and PDFs into our TMS",
  },
  {
    industry: "B2B SaaS company",
    company: ["Quantly", "Stackwise", "Formbird"],
    size: [30, 150],
    pain: "inbound demo requests wait hours before anyone replies",
  },
  {
    industry: "dental clinic group",
    company: ["BrightPath Dental", "SmileWorks Clinics"],
    size: [40, 120],
    pain: "the front desk spends hours on intake forms and appointment reminders",
  },
  {
    industry: "real estate brokerage",
    company: ["Keystone Realty", "Harbor & Co Estates"],
    size: [20, 80],
    pain: "portal leads go cold because agents can't answer fast enough",
  },
  {
    industry: "marketing agency",
    company: ["Lumen Collective", "Brightline Studio"],
    size: [15, 60],
    pain: "we manually qualify every inbound brief before a strategist sees it",
  },
  {
    industry: "accounting firm",
    company: ["Ledgerline Partners", "Crane & Hale CPA"],
    size: [25, 90],
    pain: "collecting client documents by email is chaos every quarter",
  },
] as const;

const ROLES_DECIDER = [
  "Head of Operations",
  "COO",
  "Founder & CEO",
  "VP of Sales",
  "Managing Partner",
  "Head of Growth",
];
const ROLES_OTHER = ["Operations Analyst", "Marketing Coordinator", "Office Manager"];
const BUDGETS = ["$10k", "$15–20k", "around $25,000", "€12,000", "$8–12k", "roughly $30k"];
const TIMELINES = [
  "next month",
  "within 6 weeks",
  "this quarter",
  "in the next 2 months",
  "as soon as possible",
];

const POOR_FIT = [
  {
    company: "Sunny Side Café",
    message:
      "Hi! I own a small café (3 staff). Could you build an AI that posts on our Instagram every day? Budget is maybe $300.",
  },
  {
    company: "Freelance",
    message:
      "I'm a freelancer and need a quick chatbot for my portfolio site, ideally free or under $100. Can you help this weekend?",
  },
  {
    company: "DreamApp",
    message:
      "I want to build a marketplace like Amazon with AI recommendations and a mobile app. Budget $1,000, need it in 3 weeks.",
  },
];

const SPAM = [
  {
    company: "Rank1 SEO Masters",
    message:
      "Dear business owner, your website is NOT on Google page 1!!! Buy 1000 high-DA backlinks for $49. Guaranteed. Reply YES for free audit!!!",
  },
  {
    company: "Offshore Dev Pros",
    message:
      "We are a team of 200 developers available at $9/hour. Please share your requirements and we will send a proposal within 1 hour.",
  },
  {
    company: "CryptoYield",
    message:
      "Earn 35% monthly with our AI trading bot. Limited slots left, send 0.05 BTC to activate. Don't miss out!!!",
  },
];

const NON_ENGLISH = [
  {
    lang: "de",
    company: "Brandt Maschinenbau GmbH",
    message: (b: string, t: string) =>
      `Guten Tag, ich leite den Vertrieb eines Maschinenbauunternehmens mit 120 Mitarbeitern. Wir möchten Angebotsanfragen per E-Mail mit einem KI-Agenten automatisch ins ERP übernehmen. Budget ca. ${b}, Start ${t}. Wann können wir sprechen?`,
  },
  {
    lang: "es",
    company: "Grupo Inmobiliario Solara",
    message: (b: string, t: string) =>
      `Hola, soy directora de operaciones en una inmobiliaria con 35 agentes. Queremos un agente de IA que responda y califique los leads de los portales al instante y agende visitas. Presupuesto aproximado ${b}; queremos empezar ${t}.`,
  },
  {
    lang: "tr",
    company: "Anadolu Lojistik A.Ş.",
    message: (b: string, t: string) =>
      `Merhaba, 90 kişilik bir lojistik firmasının operasyon müdürüyüm. E-postayla gelen sevkiyat taleplerini yapay zeka ile otomatik olarak sistemimize aktarmak istiyoruz. Bütçemiz yaklaşık ${b}, ${t} başlamak istiyoruz. Görüşme ayarlayabilir miyiz?`,
  },
  {
    lang: "fr",
    company: "Clinique Vétérinaire Horizon",
    message: (b: string, t: string) =>
      `Bonjour, je dirige un groupe de 4 cliniques vétérinaires. Nous voulons automatiser la prise de rendez-vous et les rappels avec l'IA. Budget d'environ ${b}, démarrage souhaité ${t}. Pouvons-nous en discuter ?`,
  },
] as const;

const NON_EN_TIMELINE: Record<string, string> = {
  de: "im nächsten Quartal",
  es: "en 4–6 semanas",
  tr: "önümüzdeki ay",
  fr: "d'ici deux mois",
};

export function generateLead(rng: Rng = Math.random): SimulatedLead {
  const roll = rng();
  const profile: SimulatedLead["profile"] =
    roll < 0.35
      ? "fit"
      : roll < 0.6
        ? "needs_info"
        : roll < 0.75
          ? "fit_non_english"
          : roll < 0.9
            ? "poor_fit"
            : "spam";
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const name = `${first} ${last}`;
  const mk = (company: string) => {
    const domain = `${slug(company) || "company"}.example`;
    return {
      company,
      email: `${slug(first)}.${slug(last)}@${domain}`,
      website: `https://${domain}`,
    };
  };

  if (profile === "spam") {
    const s = pick(rng, SPAM);
    return { profile, name, ...mk(s.company), website: null, message: s.message };
  }
  if (profile === "poor_fit") {
    const p = pick(rng, POOR_FIT);
    return { profile, name, ...mk(p.company), website: null, message: p.message };
  }
  if (profile === "fit_non_english") {
    const n = pick(rng, NON_ENGLISH);
    return {
      profile,
      name,
      ...mk(n.company),
      message: n.message(pick(rng, BUDGETS), NON_EN_TIMELINE[n.lang]!),
    };
  }

  const seg = pick(rng, B2B);
  const size = seg.size[0] + Math.floor(rng() * (seg.size[1] - seg.size[0]));
  const c = mk(pick(rng, seg.company));
  if (profile === "fit") {
    const role = pick(rng, ROLES_DECIDER);
    return {
      profile,
      name,
      ...c,
      message: `Hi, I'm ${role} at ${c.company}, a ${seg.industry} with about ${size} people. Right now ${seg.pain}. We'd like an AI agent to automate this end to end. Budget is ${pick(rng, BUDGETS)} and we want to start ${pick(rng, TIMELINES)}. Can we book a call?`,
    };
  }
  const role = pick(rng, [...ROLES_DECIDER, ...ROLES_OTHER]);
  return {
    profile,
    name,
    ...c,
    message: `Hello! I work as ${role} at a ${seg.industry} (${size} employees). ${seg.pain[0]!.toUpperCase()}${seg.pain.slice(1)}. Could AI help with that? What would a project like this look like?`,
  };
}
