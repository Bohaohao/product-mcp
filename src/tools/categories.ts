import * as z from 'zod/v4';
import type { BackendClient } from '../backendClient.js';

interface ProductCategoryNode {
  id?: string | number;
  parentId?: string | number;
  categoryName?: string;
  i18nName?: string;
  fullCode?: string;
  status?: string | number;
  children?: ProductCategoryNode[];
  [key: string]: unknown;
}

interface NormalizedCategoryNode {
  id: string;
  name: string;
  i18nName?: string;
  parentId?: string;
  fullCode?: string;
  enabled: boolean;
  children?: NormalizedCategoryNode[];
}

export const productListCategoriesInputSchema = {
  keyword: z.string().trim().optional().describe('Optional keyword to filter by categoryName or i18nName.'),
  parentId: z.string().trim().optional().describe('Optional parent category id.'),
  enabledOnly: z.boolean().default(true).describe('When true, keep only categories with status === 0.')
};

export type ProductListCategoriesInput = {
  keyword?: string;
  parentId?: string;
  enabledOnly?: boolean;
};

function isEnabled(node: ProductCategoryNode): boolean {
  return String(node.status ?? '0') === '0';
}

function normalizeNode(node: ProductCategoryNode): NormalizedCategoryNode | undefined {
  if (node.id === undefined || node.id === null || node.id === '') return undefined;

  const children = (node.children || [])
    .map((child) => normalizeNode(child))
    .filter((child): child is NormalizedCategoryNode => Boolean(child));

  return {
    id: String(node.id),
    name: String(node.categoryName || node.i18nName || node.id),
    i18nName: node.i18nName ? String(node.i18nName) : undefined,
    parentId: node.parentId !== undefined && node.parentId !== null ? String(node.parentId) : undefined,
    fullCode: node.fullCode ? String(node.fullCode) : undefined,
    enabled: isEnabled(node),
    children: children.length ? children : undefined
  };
}

function filterEnabled(nodes: NormalizedCategoryNode[], enabledOnly: boolean): NormalizedCategoryNode[] {
  if (!enabledOnly) return nodes;

  return nodes
    .filter((node) => node.enabled)
    .map((node) => ({
      ...node,
      children: node.children ? filterEnabled(node.children, enabledOnly) : undefined
    }));
}

function filterKeyword(nodes: NormalizedCategoryNode[], keyword?: string): NormalizedCategoryNode[] {
  const normalizedKeyword = keyword?.trim().toLowerCase();
  if (!normalizedKeyword) return nodes;

  const result: NormalizedCategoryNode[] = [];

  for (const node of nodes) {
    const children = node.children ? filterKeyword(node.children, normalizedKeyword) : [];
    const selfMatched = [node.name, node.i18nName, node.fullCode]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedKeyword));

    if (selfMatched || children.length > 0) {
      result.push({
        ...node,
        children: children.length ? children : undefined
      });
    }
  }

  return result;
}

function findSubtree(nodes: NormalizedCategoryNode[], parentId?: string): NormalizedCategoryNode[] {
  if (!parentId) return nodes;

  for (const node of nodes) {
    if (node.id === parentId) return node.children || [];
    const found = findSubtree(node.children || [], parentId);
    if (found.length) return found;
  }

  return [];
}

export async function productListCategories(
  backend: BackendClient,
  input: ProductListCategoriesInput,
  requestId: string
) {
  const rawTree = await backend.get<ProductCategoryNode[]>('/user/erp/productCategory/tree');
  const tree = rawTree
    .map((node) => normalizeNode(node))
    .filter((node): node is NormalizedCategoryNode => Boolean(node));
  const enabledTree = filterEnabled(tree, input.enabledOnly !== false);
  const subtree = findSubtree(enabledTree, input.parentId);
  const categories = filterKeyword(subtree, input.keyword);

  return {
    ok: true as const,
    categories,
    requestId
  };
}
