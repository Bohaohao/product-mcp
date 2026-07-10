export type MaterialIssueSeverity = 'error' | 'warning' | 'info';

export interface MaterialTemplateIssue {
  severity: MaterialIssueSeverity;
  code: string;
  message: string;
  section?: string;
  field?: string;
}

export interface MarkdownTable {
  heading: string;
  startLine: number;
  endLine: number;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface TableMergeSpec {
  headingIncludes?: string;
  requiredHeaders: string[];
  rows?: Array<Record<string, string>>;
  pathHeaders?: string[];
  uniqueHeaders?: string[];
  labelHeader?: string;
  singletonLabels?: string[];
  replaceFileStemHeaders?: string[];
  removePathValues?: string[];
}

export interface ApplyMaterialTemplateInput {
  templateMarkdown: string;
  existingMarkdown?: string;
  fieldValues: Record<string, string>;
  tableMerges: TableMergeSpec[];
}

export interface ApplyMaterialTemplateResult {
  markdown: string;
  mode: 'created' | 'updated' | 'rebuilt';
  issues: MaterialTemplateIssue[];
}

const FIELD_HEADER = '字段';
const VALUE_HEADER = '填写值';

function cleanCell(value: unknown): string {
  return String(value ?? '')
    .replace(/^`|`$/g, '')
    .trim();
}

function isBlankRow(row: Record<string, string>): boolean {
  return Object.values(row).every((value) => !cleanCell(value));
}

function parseTableLine(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return withoutEdges.split('|').map((cell) => cleanCell(cell));
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableLine(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseMarkdownTables(markdown: string): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading = '';
  let index = 0;

  while (index < lines.length) {
    const headingMatch = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = headingMatch[2];
      index += 1;
      continue;
    }

    if (lines[index].trim().startsWith('|') && lines[index + 1]?.trim().startsWith('|') && isTableSeparator(lines[index + 1])) {
      const headers = parseTableLine(lines[index]);
      const rows: Array<Record<string, string>> = [];
      const startLine = index;
      index += 2;

      while (index < lines.length && lines[index].trim().startsWith('|')) {
        const cells = parseTableLine(lines[index]);
        const row: Record<string, string> = {};
        headers.forEach((header, cellIndex) => {
          row[header] = cells[cellIndex] ?? '';
        });
        rows.push(row);
        index += 1;
      }

      tables.push({
        heading,
        startLine,
        endLine: index,
        headers,
        rows
      });
      continue;
    }

    index += 1;
  }

  return tables;
}

function hasHeaders(table: MarkdownTable, headers: string[]): boolean {
  return headers.every((header) => table.headers.includes(header));
}

function isFieldTable(table: MarkdownTable): boolean {
  return hasHeaders(table, [FIELD_HEADER, VALUE_HEADER]);
}

function tableMatches(table: MarkdownTable, spec: TableMergeSpec): boolean {
  if (spec.headingIncludes && !table.heading.includes(spec.headingIncludes)) return false;
  return hasHeaders(table, spec.requiredHeaders);
}

function firstMatchingTable(tables: MarkdownTable[], spec: TableMergeSpec): MarkdownTable | undefined {
  return tables.find((table) => tableMatches(table, spec));
}

function isStandardMaterialMarkdown(markdown: string): boolean {
  const tables = parseMarkdownTables(markdown);
  const fieldNames = new Set<string>();
  for (const table of tables.filter(isFieldTable)) {
    for (const row of table.rows) {
      const field = cleanCell(row[FIELD_HEADER]);
      if (field) fieldNames.add(field);
    }
  }

  const hasCoreFields = ['商品中文名称', '产品类型', '上架状态', '计量单位', '供应商', '包装重量 kg'].every((field) =>
    fieldNames.has(field)
  );
  const hasMediaTable = Boolean(
    firstMatchingTable(tables, {
      headingIncludes: '商品图片',
      requiredHeaders: ['图片用途', '文件路径']
    })
  );
  const hasPackageTable = Boolean(
    firstMatchingTable(tables, {
      headingIncludes: '包装配置',
      requiredHeaders: [FIELD_HEADER, VALUE_HEADER]
    })
  );

  return hasCoreFields && hasMediaTable && hasPackageTable;
}

function escapeCell(value: string): string {
  return cleanCell(value).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

function renderTable(headers: string[], rows: Array<Record<string, string>>): string[] {
  const outputRows = rows.length ? rows : [Object.fromEntries(headers.map((header) => [header, '']))];
  return [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...outputRows.map((row) => `| ${headers.map((header) => escapeCell(row[header] ?? '')).join(' | ')} |`)
  ];
}

function replaceTable(markdown: string, table: MarkdownTable, rows: Array<Record<string, string>>): string {
  const lines = markdown.split(/\r?\n/);
  lines.splice(table.startLine, table.endLine - table.startLine, ...renderTable(table.headers, rows));
  return lines.join('\n');
}

function applyFieldValues(markdown: string, fieldValues: Record<string, string>, issues: MaterialTemplateIssue[]): string {
  const fieldsToApply = new Set(Object.keys(fieldValues));
  let result = markdown;
  const tables = parseMarkdownTables(result)
    .filter(isFieldTable)
    .sort((a, b) => b.startLine - a.startLine);

  for (const table of tables) {
    let changed = false;
    const rows = table.rows.map((row) => {
      const field = cleanCell(row[FIELD_HEADER]);
      if (!fieldsToApply.has(field)) return row;
      changed = true;
      fieldsToApply.delete(field);
      return {
        ...row,
        [VALUE_HEADER]: fieldValues[field] ?? ''
      };
    });

    if (changed) result = replaceTable(result, table, rows);
  }

  for (const field of fieldsToApply) {
    issues.push({
      severity: 'warning',
      code: 'TEMPLATE_FIELD_NOT_FOUND',
      field,
      message: `模板中未找到字段：${field}。`
    });
  }

  return result;
}

function rowKey(row: Record<string, string>, headers: string[]): string {
  return headers.map((header) => cleanCell(row[header])).join('\u0000');
}

function firstFilled(row: Record<string, string>, headers: string[]): string {
  for (const header of headers) {
    const value = cleanCell(row[header]);
    if (value) return value;
  }
  return '';
}

function fileStemFromRow(row: Record<string, string>, pathHeaders: string[]): string {
  const value = firstFilled(row, pathHeaders).replace(/\\/g, '/');
  if (!value) return '';
  const fileName = value.split('/').pop() || '';
  return fileName.replace(/\.[^.]+$/, '');
}

function mergeKeepingExistingValues(
  generated: Record<string, string>,
  existing: Record<string, string> | undefined,
  spec: TableMergeSpec
): Record<string, string> {
  const merged = { ...generated };
  if (!existing) return merged;

  const pathHeaders = spec.pathHeaders || ['文件路径', '图片路径', '附件路径', '主图路径', '文件路径或内容'];
  const replaceFileStemHeaders = new Set(spec.replaceFileStemHeaders || []);
  const existingFileStem = fileStemFromRow(existing, pathHeaders);

  for (const [key, value] of Object.entries(existing)) {
    if (!cleanCell(value)) continue;
    if (replaceFileStemHeaders.has(key) && cleanCell(value) === existingFileStem && cleanCell(generated[key])) continue;
    merged[key] = value;
  }

  return merged;
}

function mergeRows(existingRows: Array<Record<string, string>>, spec: TableMergeSpec): Array<Record<string, string>> {
  const pathHeaders = spec.pathHeaders || ['文件路径', '图片路径', '附件路径', '主图路径', '文件路径或内容'];
  const normalizePathValue = (value: string) => cleanCell(value).replace(/\\/g, '/').replace(/^\.\//, '').normalize('NFC').toLowerCase();
  const removePathValues = new Set((spec.removePathValues || []).map(normalizePathValue));
  const rows = existingRows
    .filter((row) => !isBlankRow(row))
    .filter((row) => !pathHeaders.some((header) => removePathValues.has(normalizePathValue(row[header] || ''))))
    .map((row) => ({ ...row }));
  const generatedRows = spec.rows || [];
  const uniqueHeaders = spec.uniqueHeaders || pathHeaders;
  const singletonLabels = new Set(spec.singletonLabels || []);

  for (const generatedRow of generatedRows.filter((row) => !isBlankRow(row))) {
    const label = spec.labelHeader ? cleanCell(generatedRow[spec.labelHeader]) : '';
    const generatedPathKey = rowKey(generatedRow, pathHeaders);
    const generatedUniqueKey = rowKey(generatedRow, uniqueHeaders);

    if (label && singletonLabels.has(label)) {
      const preserved = rows.find((row) => cleanCell(row[spec.labelHeader || '']) === label);
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (cleanCell(rows[index][spec.labelHeader || '']) === label) rows.splice(index, 1);
      }
      rows.push(mergeKeepingExistingValues(generatedRow, preserved, spec));
      continue;
    }

    const existingIndex = rows.findIndex((row) => {
      const existingPathKey = rowKey(row, pathHeaders);
      if (generatedPathKey && existingPathKey === generatedPathKey) return true;
      const existingUniqueKey = rowKey(row, uniqueHeaders);
      return Boolean(generatedUniqueKey && existingUniqueKey === generatedUniqueKey);
    });

    if (existingIndex >= 0) {
      rows[existingIndex] = mergeKeepingExistingValues(generatedRow, rows[existingIndex], spec);
      continue;
    }

    const blankIndex = rows.findIndex((row) => {
      if (!spec.labelHeader || cleanCell(row[spec.labelHeader]) !== label) return false;
      return !firstFilled(row, pathHeaders);
    });

    if (blankIndex >= 0) {
      rows[blankIndex] = mergeKeepingExistingValues(generatedRow, rows[blankIndex], spec);
      continue;
    }

    rows.push(generatedRow);
  }

  return rows;
}

function applyTableMerges(markdown: string, specs: TableMergeSpec[], issues: MaterialTemplateIssue[]): string {
  let result = markdown;

  for (const spec of specs) {
    if (!(spec.rows || []).length && !(spec.removePathValues || []).length) continue;
    const tables = parseMarkdownTables(result);
    const table = firstMatchingTable(tables, spec);
    if (!table) {
      issues.push({
        severity: 'warning',
        code: 'TEMPLATE_TABLE_NOT_FOUND',
        section: spec.headingIncludes,
        message: `模板中未找到可合并表格：${spec.headingIncludes || spec.requiredHeaders.join(', ')}。`
      });
      continue;
    }

    result = replaceTable(result, table, mergeRows(table.rows, spec));
  }

  return result;
}

function extractExistingFieldValues(markdown: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const table of parseMarkdownTables(markdown).filter(isFieldTable)) {
    for (const row of table.rows) {
      const field = cleanCell(row[FIELD_HEADER]);
      const value = cleanCell(row[VALUE_HEADER]);
      if (field && value && values[field] === undefined) values[field] = value;
    }
  }
  return values;
}

function isMigratableDataTable(table: MarkdownTable): boolean {
  if (isFieldTable(table)) return false;
  const headers = new Set(table.headers);
  return (
    headers.has('文件路径') ||
    headers.has('图片路径') ||
    headers.has('附件路径') ||
    headers.has('主图路径') ||
    headers.has('文件路径或内容') ||
    headers.has('配置项名称') ||
    headers.has('参数名称') ||
    headers.has('配置名称') ||
    headers.has('供应商名称') ||
    headers.has('区域名称') ||
    headers.has('证书名称') ||
    headers.has('客户名称') ||
    headers.has('所属客户名称') ||
    headers.has('名称')
  );
}

function migrateExistingDataRows(templateMarkdown: string, existingMarkdown: string, issues: MaterialTemplateIssue[]): string {
  let result = templateMarkdown;
  const existingTables = parseMarkdownTables(existingMarkdown).filter(isMigratableDataTable);

  for (const existingTable of existingTables) {
    const rows = existingTable.rows.filter((row) => !isBlankRow(row));
    if (!rows.length) continue;

    const requiredHeaders = existingTable.headers.filter((header) => header !== '');
    result = applyTableMerges(
      result,
      [
        {
          headingIncludes: existingTable.heading,
          requiredHeaders,
          rows,
          uniqueHeaders: ['文件路径', '图片路径', '附件路径', '主图路径', '文件路径或内容', '名称', '客户名称', '所属客户名称', '证书名称'].filter(
            (header) => existingTable.headers.includes(header)
          )
        }
      ],
      issues
    );
  }

  return result;
}

function migrateExistingOntoTemplate(templateMarkdown: string, existingMarkdown: string, issues: MaterialTemplateIssue[]): string {
  let result = templateMarkdown;
  const existingFieldValues = extractExistingFieldValues(existingMarkdown);
  result = applyFieldValues(result, existingFieldValues, issues);
  result = migrateExistingDataRows(result, existingMarkdown, issues);
  return result;
}

function normalizeFinalMarkdown(markdown: string): string {
  return `${markdown.replace(/\s+$/g, '')}\n`;
}

export function applyMaterialTemplate(input: ApplyMaterialTemplateInput): ApplyMaterialTemplateResult {
  const issues: MaterialTemplateIssue[] = [];
  let mode: ApplyMaterialTemplateResult['mode'] = 'created';
  let baseMarkdown = input.templateMarkdown;

  if (input.existingMarkdown !== undefined) {
    if (isStandardMaterialMarkdown(input.existingMarkdown)) {
      mode = 'updated';
      baseMarkdown = input.existingMarkdown;
    } else {
      mode = 'rebuilt';
      issues.push({
        severity: 'warning',
        code: 'TEMPLATE_REBUILT',
        message: '已有商品资料.md 结构不标准，已基于标准模板重建并迁移可识别值。'
      });
      baseMarkdown = migrateExistingOntoTemplate(input.templateMarkdown, input.existingMarkdown, issues);
    }
  }

  let markdown = applyFieldValues(baseMarkdown, input.fieldValues, issues);
  markdown = applyTableMerges(markdown, input.tableMerges, issues);

  return {
    markdown: normalizeFinalMarkdown(markdown),
    mode,
    issues
  };
}
