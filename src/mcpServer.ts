import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProductMcpConfig } from './config.js';
import { BackendClient } from './backendClient.js';
import type { ProductRequestContext } from './requestContext.js';
import { mapUnknownError, toErrorPayload } from './errors.js';
import { productListCategories, productListCategoriesInputSchema } from './tools/categories.js';
import { productCreate, productCreateInputSchema } from './tools/createProduct.js';
import {
  productGetCategoryConfig,
  productGetCategoryConfigInputSchema,
  productGetDict,
  productGetDictInputSchema,
  productListRegions,
  productListRegionsInputSchema,
  productListSuppliers,
  productListSuppliersInputSchema
} from './tools/references.js';
import { productGetDetail, productGetDetailInputSchema } from './tools/productDetail.js';
import { productCheckNameDuplicate, productCheckNameDuplicateInputSchema } from './tools/productSearch.js';

function toolResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function errorToolResult(error: unknown, requestId: string) {
  return toolResult(toErrorPayload(error, requestId));
}

export function createProductMcpServer(config: ProductMcpConfig, context: ProductRequestContext): McpServer {
  const server = new McpServer({
    name: 'product',
    version: '0.1.0'
  });

  const backend = new BackendClient(config, context);

  server.registerTool(
    'product_list_categories',
    {
      title: 'List product categories',
      description: 'Query the ERP product category tree available to the current user.',
      inputSchema: productListCategoriesInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productListCategories(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_create',
    {
      title: 'Create product',
      description:
        'Create a real ERP product through POST /user/erp/commodity. Use previewOnly=true to validate and inspect the final submission preview without creating. For real creation pass confirm=true. This remote tool accepts business fields and already-uploaded OSS URLs only; never send local paths, file bytes, or large base64 payloads here.',
      inputSchema: productCreateInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productCreate(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_check_name_duplicate',
    {
      title: 'Check duplicate product name',
      description:
        'Search ERP products by Chinese product name and return whether an exact same-name product already exists. Use after package required-field validation passes and before upload/create.',
      inputSchema: productCheckNameDuplicateInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productCheckNameDuplicate(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_get_category_config',
    {
      title: 'Get product category config',
      description: 'Query units, base configs, technical params, and optional configs for a selected product category.',
      inputSchema: productGetCategoryConfigInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productGetCategoryConfig(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_list_suppliers',
    {
      title: 'List suppliers',
      description: 'Query supplier classification tree and flatten supplier options for product creation.',
      inputSchema: productListSuppliersInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productListSuppliers(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_list_regions',
    {
      title: 'List product regions',
      description: 'Query regional organization options used by product applicable regions.',
      inputSchema: productListRegionsInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productListRegions(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_get_dict',
    {
      title: 'Get system dict',
      description: 'Query system dictionary values, for example erp_customer_type.',
      inputSchema: productGetDictInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productGetDict(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  server.registerTool(
    'product_get_detail',
    {
      title: 'Get product detail',
      description: 'Query product edit detail sections after product_create for MCP acceptance checks.',
      inputSchema: productGetDetailInputSchema
    },
    async (input) => {
      try {
        return toolResult(await productGetDetail(backend, input, context.requestId));
      } catch (error) {
        return errorToolResult(mapUnknownError(error), context.requestId);
      }
    }
  );

  return server;
}
