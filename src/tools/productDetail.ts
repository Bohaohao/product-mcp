import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';

export const productGetDetailInputSchema = {
  productId: z.union([z.string().trim().min(1), z.number()]).describe('ERP product id returned by product_create.'),
  includeSections: z
    .array(z.enum(['base', 'medias', 'sales', 'parts', 'certifications']))
    .default(['base', 'medias', 'sales', 'parts', 'certifications'])
    .describe('Detail sections to query.')
};

const productGetDetailObjectSchema = z.object(productGetDetailInputSchema);
type ProductGetDetailInput = z.infer<typeof productGetDetailObjectSchema>;

type DetailSection = ProductGetDetailInput['includeSections'][number];

function productIdText(value: ProductGetDetailInput['productId']): string {
  return String(value).trim();
}

async function getSection(backend: BackendClient, productId: string, section: DetailSection) {
  switch (section) {
    case 'base':
      return await backend.get(`/user/erp/commodity/base/${encodeURIComponent(productId)}`);
    case 'medias':
      return await backend.get(`/user/erp/commodity/medias/${encodeURIComponent(productId)}`);
    case 'sales':
      return await backend.get(`/user/erp/commodity/sales/${encodeURIComponent(productId)}`);
    case 'parts':
      return await backend.get(`/user/erp/commodity/parts/${encodeURIComponent(productId)}`);
    case 'certifications':
      return await backend.get(`/user/erp/commodity/certifications/${encodeURIComponent(productId)}`);
  }
}

export async function productGetDetail(backend: BackendClient, rawInput: unknown, requestId: string) {
  const input = productGetDetailObjectSchema.parse(rawInput);
  const productId = productIdText(input.productId);
  const sections: Record<string, unknown> = {};

  for (const section of input.includeSections) {
    sections[section] = await getSection(backend, productId, section);
  }

  return {
    ok: true as const,
    productId,
    ...sections,
    requestId
  };
}
