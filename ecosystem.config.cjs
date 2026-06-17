module.exports = {
  apps: [
    {
      name: 'product-mcp',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PRODUCT_MCP_PORT: process.env.PRODUCT_MCP_PORT || '8787',
        PRODUCT_MCP_HOST: process.env.PRODUCT_MCP_HOST || '0.0.0.0',
        PRODUCT_MCP_PATH: process.env.PRODUCT_MCP_PATH || '/mcp',
        PRODUCT_MCP_ALLOWED_HOSTS: process.env.PRODUCT_MCP_ALLOWED_HOSTS || '',
        PRODUCT_MCP_BACKEND_BASE_URL: process.env.PRODUCT_MCP_BACKEND_BASE_URL || '',
        PRODUCT_MCP_CLIENT_ID: process.env.PRODUCT_MCP_CLIENT_ID || 'e5cd7e4891bf95d1d19206ce24a7b32e',
        PRODUCT_MCP_REQUEST_TIMEOUT_MS: process.env.PRODUCT_MCP_REQUEST_TIMEOUT_MS || '50000',
        PRODUCT_MCP_DEFAULT_LANGUAGE: process.env.PRODUCT_MCP_DEFAULT_LANGUAGE || 'zh_CN'
      }
    }
  ]
};
