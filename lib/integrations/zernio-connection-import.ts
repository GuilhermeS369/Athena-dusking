export type ZernioConnectionImportRow = {
  lineNumber: number;
  label: string;
  apiKey: string;
};

export type ZernioConnectionImportIssue = {
  lineNumber: number;
  field: 'name' | 'apiKey' | 'batch';
  message: string;
};

export type ZernioConnectionImportDraft = {
  rows: ZernioConnectionImportRow[];
  nameCount: number;
  apiKeyCount: number;
  issues: ZernioConnectionImportIssue[];
  valid: boolean;
};

function inputLines(value: string) {
  const lines = value.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
  return lines;
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

/** Mantém o pareamento pela posição visual; uma linha vazia no meio é tratada como erro. */
export function parseZernioConnectionImport(namesText: string, apiKeysText: string): ZernioConnectionImportDraft {
  const names = inputLines(namesText);
  const apiKeys = inputLines(apiKeysText);
  const issues: ZernioConnectionImportIssue[] = [];

  if (names.length !== apiKeys.length) {
    issues.push({
      lineNumber: 0,
      field: 'batch',
      message: `Há ${names.length} nome(s) e ${apiKeys.length} API key(s). As duas colunas precisam ter a mesma quantidade de linhas.` ,
    });
  }

  const rows = Array.from({ length: Math.max(names.length, apiKeys.length) }, (_, index) => ({
    lineNumber: index + 1,
    label: normalizeLabel(names[index] ?? ''),
    apiKey: apiKeys[index]?.trim() ?? '',
  }));
  const labels = new Map<string, number>();
  const apiKeyLines = new Map<string, number>();

  rows.forEach((row) => {
    if (!row.label) {
      issues.push({ lineNumber: row.lineNumber, field: 'name', message: 'Informe o nome da conta nesta linha.' });
    } else if (row.label.length < 2 || row.label.length > 80) {
      issues.push({ lineNumber: row.lineNumber, field: 'name', message: 'O nome deve ter entre 2 e 80 caracteres.' });
    }
    if (!row.apiKey) {
      issues.push({ lineNumber: row.lineNumber, field: 'apiKey', message: 'Informe a API key correspondente nesta linha.' });
    } else if (row.apiKey.length < 12 || row.apiKey.length > 2000) {
      issues.push({ lineNumber: row.lineNumber, field: 'apiKey', message: 'Informe uma API key Zernio válida.' });
    }
    const normalized = row.label.toLocaleLowerCase('pt-BR');
    const firstLine = labels.get(normalized);
    if (firstLine) {
      issues.push({ lineNumber: row.lineNumber, field: 'name', message: `Nome repetido no lote (já usado na linha ${firstLine}).` });
    } else if (normalized) {
      labels.set(normalized, row.lineNumber);
    }

    const firstApiKeyLine = apiKeyLines.get(row.apiKey);
    if (firstApiKeyLine) {
      issues.push({ lineNumber: row.lineNumber, field: 'apiKey', message: `API key repetida no lote (já usada na linha ${firstApiKeyLine}).` });
    } else if (row.apiKey) {
      apiKeyLines.set(row.apiKey, row.lineNumber);
    }
  });

  if (rows.length === 0) issues.push({ lineNumber: 0, field: 'batch', message: 'Cole ao menos um nome e uma API key.' });
  return { rows, nameCount: names.length, apiKeyCount: apiKeys.length, issues, valid: issues.length === 0 };
}
