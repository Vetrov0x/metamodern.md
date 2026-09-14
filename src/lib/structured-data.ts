export const METAMODERN_COMPANY_ORGANIZATION_ID = 'https://metamodern.company/#organization';
export const METAMODERN_COMPANY_NAME = 'Metamodern Company';
export const METAMODERN_COMPANY_URL = 'https://metamodern.company/';

export const METAMODERN_MD_WEBSITE_ID = 'https://metamodern.md/#website';
export const METAMODERN_MD_WEBSITE_NAME = 'metamodern.md';
export const METAMODERN_MD_WEBSITE_URL = 'https://metamodern.md/';
export const METAMODERN_MD_WEBSITE_DESCRIPTION =
  'A public knowledge and manifest site about metamodernism, its provenance, and applied practice.';

export const METAMODERN_COMPANY_SAME_AS = Object.freeze([
  'https://www.linkedin.com/company/metamodern-company/',
  'https://x.com/Metamodern0x',
]);

export function createMetamodernCompanyPublisher() {
  return {
    '@type': 'Organization',
    '@id': METAMODERN_COMPANY_ORGANIZATION_ID,
    name: METAMODERN_COMPANY_NAME,
    url: METAMODERN_COMPANY_URL,
    sameAs: [...METAMODERN_COMPANY_SAME_AS],
  };
}

export function createMetamodernCompanyPublisherReference() {
  return { '@id': METAMODERN_COMPANY_ORGANIZATION_ID };
}

export function createMetamodernMdWebsite({ aboutId }: { aboutId?: string } = {}) {
  return {
    '@type': 'WebSite',
    '@id': METAMODERN_MD_WEBSITE_ID,
    name: METAMODERN_MD_WEBSITE_NAME,
    url: METAMODERN_MD_WEBSITE_URL,
    description: METAMODERN_MD_WEBSITE_DESCRIPTION,
    publisher: createMetamodernCompanyPublisherReference(),
    ...(aboutId ? { about: { '@id': aboutId } } : {}),
  };
}
