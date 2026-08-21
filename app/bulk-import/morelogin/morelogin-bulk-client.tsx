'use client';

import { useEffect, useMemo, useState } from 'react';

type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

type ImportTarget = 'chrome' | 'cloudphone';
type ProxyType = 'HTTP' | 'HTTPS' | 'SOCKS5' | 'SSH';
type CloudPhoneModel = 'Android 15' | 'Android 14' | 'Android 13' | 'Android 12' | 'Android 15A' | 'Android 11' | 'Android 16';

type ParsedAccount = {
  id: string;
  line: number;
  profileName: string;
  login: string;
  password: string;
  twoFa: string;
};

type ParsedProxy = {
  id: string;
  line: number;
  raw: string;
  host: string;
  port: string;
  username: string;
  password: string;
};

type ParsedLineError = { line: number; text: string; reason: string };
type TotpState = Record<string, { code: string; valid: boolean; error?: string }>;

const chromeHeaders = ['Profile name', 'Platform', 'User-defined platform domain name', 'Login account', 'Login password', '2FA key', 'Cookie', 'Proxy type', 'Proxy information', 'Proxy Name', 'Proxy Number', 'Profile group', 'Profile tag', 'Profile note', 'Custom number', 'UA'];
const cloudPhoneHeaders = ['Profile name', 'Model', 'Proxy type', 'Proxy information', 'Proxy Name', 'Proxy Number', 'Group', 'Tags', 'Notes', 'Custom number'];
const cloudPhoneModels: CloudPhoneModel[] = ['Android 15', 'Android 14', 'Android 13', 'Android 12', 'Android 15A', 'Android 11', 'Android 16'];
const proxyTypes: ProxyType[] = ['HTTP', 'HTTPS', 'SOCKS5', 'SSH'];

function normalizeSecret(value: string) {
  return value.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
}

function parseAccounts(input: string) {
  const accounts: ParsedAccount[] = [];
  const errors: ParsedLineError[] = [];
  input.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split(/[:;]/);
    if (parts.length < 3) {
      errors.push({ line: index + 1, text: rawLine, reason: 'Use usuario:senha:2fa ou usuario;senha;2fa.' });
      return;
    }
    const login = parts[0]?.trim() ?? '';
    const password = parts[1]?.trim() ?? '';
    const twoFa = normalizeSecret(parts.slice(2).join(':'));
    if (!login || !password || !twoFa) {
      errors.push({ line: index + 1, text: rawLine, reason: 'Usuário, senha e 2FA são obrigatórios.' });
      return;
    }
    accounts.push({ id: `${index}-${login}`, line: index + 1, profileName: login.slice(0, 64), login, password, twoFa });
  });
  return { accounts, errors };
}

function parseProxies(input: string) {
  const proxies: ParsedProxy[] = [];
  const errors: ParsedLineError[] = [];
  input.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split(':');
    if (parts.length < 2) {
      errors.push({ line: index + 1, text: rawLine, reason: 'Use host:porta ou host:porta:usuario:senha.' });
      return;
    }
    const host = parts[0]?.trim() ?? '';
    const port = parts[1]?.trim() ?? '';
    const username = parts[2]?.trim() ?? '';
    const password = parts.slice(3).join(':').trim();
    if (!host || !port) {
      errors.push({ line: index + 1, text: rawLine, reason: 'Host e porta são obrigatórios quando a linha de proxy é preenchida.' });
      return;
    }
    proxies.push({ id: `${index}-${host}-${port}`, line: index + 1, raw: line, host, port, username, password });
  });
  return { proxies, errors };
}

function decodeBase32(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = normalizeSecret(secret).replace(/=+$/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('Chave 2FA fora do padrão Base32.');
  let bits = '';
  for (const character of clean) {
    const value = alphabet.indexOf(character);
    if (value === -1) throw new Error('Chave 2FA contém caractere inválido.');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let cursor = 0; cursor + 8 <= bits.length; cursor += 8) bytes.push(Number.parseInt(bits.slice(cursor, cursor + 8), 2));
  return new Uint8Array(bytes);
}

function counterToBuffer(counter: number) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);
  return buffer;
}

async function generateTotp(secret: string, timestamp = Date.now()) {
  const keyData = decodeBase32(secret);
  const counter = Math.floor(timestamp / 1000 / 30);
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterToBuffer(counter)));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24) | ((signature[offset + 1] & 0xff) << 16) | ((signature[offset + 2] & 0xff) << 8) | (signature[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, '0');
}

function profileNote(account: ParsedAccount) {
  return [`usuario: ${account.login}`, `senha: ${account.password}`, `2fa: ${account.twoFa}`].join('\n');
}

function buildWorkbookRows(target: ImportTarget, accounts: ParsedAccount[], proxies: ParsedProxy[], proxyType: ProxyType, model: CloudPhoneModel, groupName: string) {
  const workbookGroupName = groupName.trim() ? groupName : '';
  if (target === 'chrome') {
    return [
      ['Notas para preencher: não altere campos. Dados a partir da quarta linha. Limite MoreLogin: 300 linhas.'],
      chromeHeaders,
      ['Nome do ambiente obrigatório', 'Sua plataforma opcional', 'Domínio customizado opcional', 'Conta de login', 'Senha de login', 'Chave 2FA', 'Cookie', 'Tipo de protocolo', 'Informações do proxy', 'Nome do Proxy', 'Número do Proxy', 'Grupo', 'Tag', 'OBS do ambiente', 'Número customizado', 'UA'],
      ...accounts.map((account, index) => {
        const proxy = proxies[index];
        return [account.profileName, '', '', account.login, account.password, account.twoFa, '', proxy ? proxyType : '', proxy?.raw ?? '', '', '', workbookGroupName, '', profileNote(account), '', ''];
      }),
    ];
  }
  return [
    ['Instruções de preenchimento: não altere campos. Dados a partir da quarta linha. Limite MoreLogin: 300 linhas.'],
    cloudPhoneHeaders,
    ['Nome do Perfil', 'Versão do modelo', 'Tipo de protocolo', 'Informações de proxy', 'Nome do Proxy', 'Número do Proxy', 'Grupo', 'Tags', 'Observações sobre o Cloud Phone', 'Número customizado'],
    ...accounts.map((account, index) => {
      const proxy = proxies[index];
      return [account.profileName, model, proxy ? proxyType : '', proxy?.raw ?? '', '', '', workbookGroupName, '', profileNote(account), ''];
    }),
  ];
}

function fileDateStamp() {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date())
    .replace(/\D/g, '-')
    .replace(/-$/g, '');
}

export default function MoreLoginBulkClient({ activeOrganization }: { activeOrganization: Organization }) {
  const [target, setTarget] = useState<ImportTarget>('cloudphone');
  const [model, setModel] = useState<CloudPhoneModel>('Android 15');
  const [proxyType, setProxyType] = useState<ProxyType>('HTTP');
  const [groupName, setGroupName] = useState('');
  const [accountsText, setAccountsText] = useState('');
  const [proxiesText, setProxiesText] = useState('');
  const [filter, setFilter] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(30 - (Math.floor(Date.now() / 1000) % 30));
  const [totpState, setTotpState] = useState<TotpState>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [bulkCodesCopied, setBulkCodesCopied] = useState(false);
  const [bulkCopiedField, setBulkCopiedField] = useState<'logins' | 'passwords' | null>(null);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');

  const parsedAccounts = useMemo(() => parseAccounts(accountsText), [accountsText]);
  const parsedProxies = useMemo(() => parseProxies(proxiesText), [proxiesText]);
  const accounts = parsedAccounts.accounts;
  const proxies = parsedProxies.proxies;
  const invalidAccounts = parsedAccounts.errors;
  const invalidProxies = parsedProxies.errors;
  const usableAccounts = useMemo(() => accounts.slice(0, 300), [accounts]);
  const overLimitCount = Math.max(accounts.length - 300, 0);
  const accountsWith2fa = usableAccounts.filter((account) => account.twoFa).length;
  const fixedProxyCount = Math.min(usableAccounts.length, proxies.length);
  const missingProxyCount = Math.max(usableAccounts.length - proxies.length, 0);
  const extraProxyCount = Math.max(proxies.length - usableAccounts.length, 0);
  const filteredAccounts = usableAccounts.filter((account) => {
    const term = filter.trim().toLowerCase();
    if (!term) return true;
    return account.profileName.toLowerCase().includes(term) || account.login.toLowerCase().includes(term) || account.password.toLowerCase().includes(term);
  });

  useEffect(() => {
    let cancelled = false;
    async function refreshCodes() {
      const nextState: TotpState = {};
      await Promise.all(usableAccounts.map(async (account) => {
        try {
          nextState[account.id] = { code: await generateTotp(account.twoFa), valid: true };
        } catch (error) {
          nextState[account.id] = { code: '------', valid: false, error: error instanceof Error ? error.message : 'Chave 2FA inválida.' };
        }
      }));
      if (!cancelled) setTotpState(nextState);
    }
    void refreshCodes();
    const interval = window.setInterval(() => {
      const nextSecondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
      setSecondsLeft(nextSecondsLeft);
      if (nextSecondsLeft === 30) void refreshCodes();
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [usableAccounts]);

  async function copyValue(value: string, label: string, key?: string) {
    if (!value || value === '------') return;
    try {
      await navigator.clipboard.writeText(value);
      if (key) {
        setCopiedKey(key);
        window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1300);
      }
      setMessage(`${label} copiado.`);
      setMessageTone('success');
    } catch {
      setMessage('Não foi possível copiar automaticamente neste navegador.');
      setMessageTone('error');
    }
  }

  async function copyVisibleTotpCodes() {
    const codes = filteredAccounts
      .map((account) => totpState[account.id])
      .filter((code): code is { code: string; valid: true; error?: string } => Boolean(code?.valid && code.code && code.code !== '------'))
      .map((code) => code.code);

    if (codes.length === 0) {
      setMessage('Nenhum código 2FA válido visível para copiar.');
      setMessageTone('error');
      return;
    }

    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setBulkCodesCopied(true);
      window.setTimeout(() => setBulkCodesCopied(false), 1300);
      setMessage(`${codes.length} código(s) 2FA visível(is) copiado(s) em linhas.`);
      setMessageTone('success');
    } catch {
      setMessage('Não foi possível copiar automaticamente neste navegador.');
      setMessageTone('error');
    }
  }

  async function copyAccountColumn(field: 'logins' | 'passwords') {
    const values = usableAccounts.map((account) => (field === 'logins' ? account.login : account.password));
    const label = field === 'logins' ? 'login(s)' : 'senha(s)';

    if (values.length === 0) {
      setMessage(`Nenhum ${field === 'logins' ? 'login' : 'senha'} válido para copiar.`);
      setMessageTone('error');
      return;
    }

    try {
      await navigator.clipboard.writeText(values.join('\n'));
      setBulkCopiedField(field);
      window.setTimeout(() => setBulkCopiedField((current) => (current === field ? null : current)), 1300);
      setMessage(`${values.length} ${label} copiado(s) em linhas.`);
      setMessageTone('success');
    } catch {
      setMessage('Não foi possível copiar automaticamente neste navegador.');
      setMessageTone('error');
    }
  }

  function clearAll() {
    setGroupName('');
    setAccountsText('');
    setProxiesText('');
    setFilter('');
    setMessage('Campos limpos.');
    setMessageTone('neutral');
  }

  async function downloadWorkbook() {
    if (usableAccounts.length === 0) {
      setMessage('Cole pelo menos uma conta válida no formato usuario:senha:2fa.');
      setMessageTone('error');
      return;
    }
    if (invalidAccounts.length || invalidProxies.length) {
      setMessage('Corrija as linhas inválidas antes de baixar o Excel.');
      setMessageTone('error');
      return;
    }
    const XLSX = await import('xlsx');
    const workbook = XLSX.utils.book_new();
    const sheetName = target === 'chrome' ? 'Perfil (obrigatório)' : 'Informações do telefone na nuve';
    const rows = buildWorkbookRows(target, usableAccounts, proxies, proxyType, model, groupName);
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = (target === 'chrome' ? chromeHeaders : cloudPhoneHeaders).map((header) => ({ wch: Math.max(header.length + 4, 18) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    if (target === 'chrome') {
      const extraSheet = XLSX.utils.aoa_to_sheet([
        ['Notas: use esta aba apenas para contas adicionais no mesmo perfil.'],
        ['Profile name', 'Platform', 'User-defined platform domain name', 'Login account', 'Login password'],
        ['Nome do perfil', 'Plataforma', 'Domínio customizado', 'Conta de login', 'Senha de login'],
      ]);
      XLSX.utils.book_append_sheet(workbook, extraSheet, 'Conta adicional (opcional)');
    } else {
      const optionsSheet = XLSX.utils.aoa_to_sheet([
        ['Socks5', 'Android 15'],
        ['HTTP', 'Android 14'],
        ['HTTPS', 'Android 13'],
        ['', 'Android 12'],
        ['', 'Android 15A'],
        ['', 'Android 11'],
        ['', 'Android 16'],
      ]);
      XLSX.utils.book_append_sheet(workbook, optionsSheet, 'Opções');
    }
    const filename = target === 'chrome' ? `morelogin-chrome-${fileDateStamp()}.xlsx` : `morelogin-cloudphone-${fileDateStamp()}.xlsx`;
    XLSX.writeFile(workbook, filename, { bookType: 'xlsx' });
    setMessage(`Arquivo ${filename} gerado com ${usableAccounts.length} perfil(is).`);
    setMessageTone('success');
  }

  const primaryDownloadLabel = target === 'chrome' ? 'Baixar .xlsx Chrome' : 'Baixar .xlsx Cloud Phone';

  return (
    <main className="standalone-page bulk-import-page morelogin-bulk-page">
      <header className="standalone-header bulk-import-hero">
        <div>
          <span className="section-kicker">{activeOrganization.name} · MoreLogin</span>
          <h1>Bulk Import</h1>
          <p>Cole contas no formato <strong>usuario:senha:2fa</strong> ou <strong>usuario;senha;2fa</strong>, gere o Excel oficial para Chrome ou Cloud Phone e copie os códigos 2FA ao vivo abaixo.</p>
        </div>
      </header>

      {message && <p className={`inline-message inline-message-${messageTone}`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</p>}

      <section className="panel bulk-import-toolbar" aria-label="Configuração do arquivo MoreLogin">
        <div className="bulk-target-switch" role="group" aria-label="Tipo de importação MoreLogin">
          <button className={target === 'chrome' ? 'bulk-target-active' : ''} type="button" onClick={() => setTarget('chrome')}><span className="bulk-button-icon bulk-button-icon-browser" aria-hidden="true" /> Chrome</button>
          <button className={target === 'cloudphone' ? 'bulk-target-active' : ''} type="button" onClick={() => setTarget('cloudphone')}><span className="bulk-button-icon bulk-button-icon-phone" aria-hidden="true" /> Cloud Phone</button>
        </div>
        <div className="bulk-toolbar-controls">
          {target === 'cloudphone' && <label>Model<select value={model} onChange={(event) => setModel(event.target.value as CloudPhoneModel)}>{cloudPhoneModels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}
          <label>Proxy type<select value={proxyType} onChange={(event) => setProxyType(event.target.value as ProxyType)}>{proxyTypes.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label className="bulk-toolbar-group-field" htmlFor="bulk-group-name">Nome do grupo<input id="bulk-group-name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Ex: MoreLogin existente" /><span className="bulk-toolbar-field-help">Opcional, repetido em todos os perfis.</span></label>
          <button className="button button-ghost bulk-action-button" type="button" onClick={clearAll}><span className="bulk-action-icon bulk-action-icon-trash" aria-hidden="true" />Limpar</button>
          <button className="button button-primary bulk-action-button" type="button" onClick={() => void downloadWorkbook()}><span className="bulk-action-icon bulk-action-icon-upload" aria-hidden="true" />{primaryDownloadLabel}</button>
        </div>
      </section>

      <section className="bulk-metric-grid" aria-label="Resumo do bulk import">
        <article className="metric-card"><span className="metric-label">Contas</span><strong>{usableAccounts.length}</strong><span className="metric-caption">{overLimitCount ? `${overLimitCount} fora do limite` : 'Linhas válidas'}</span></article>
        <article className="metric-card"><span className="metric-label">Com 2FA</span><strong>{accountsWith2fa}</strong><span className="metric-caption">Códigos ao vivo</span></article>
        <article className="metric-card"><span className="metric-label">Proxies</span><strong>{proxies.length}</strong><span className="metric-caption">Linhas válidas</span></article>
        <article className="metric-card"><span className="metric-label">Modelo</span><strong>{target === 'chrome' ? 'Chrome' : model.replace('Android ', 'A')}</strong><span className="metric-caption">{target === 'chrome' ? 'Perfil de navegador' : 'Cloud Phone'}</span></article>
      </section>

      <section className="bulk-editor-grid">
        <div className="panel bulk-textarea-panel">
          <span>
            <label className="bulk-textarea-title" htmlFor="bulk-accounts"><strong>Contas</strong></label>
            <span className="bulk-account-copy-cluster">
              <span className="bulk-account-copy-actions" aria-label="Copiar dados das contas em linhas para planilha">
                <button className={`bulk-account-copy-button ${bulkCopiedField === 'logins' ? 'bulk-account-copy-button-copied' : ''}`} type="button" onClick={() => void copyAccountColumn('logins')} disabled={usableAccounts.length === 0} aria-label="Copiar todos os logins em ordem, um por linha" title="Copiar logins em linhas">
                  <span className="bulk-account-copy-icon bulk-account-copy-icon-login" aria-hidden="true" />
                </button>
                <button className={`bulk-account-copy-button ${bulkCopiedField === 'passwords' ? 'bulk-account-copy-button-copied' : ''}`} type="button" onClick={() => void copyAccountColumn('passwords')} disabled={usableAccounts.length === 0} aria-label="Copiar todas as senhas em ordem, uma por linha" title="Copiar senhas em linhas">
                  <span className="bulk-account-copy-icon bulk-account-copy-icon-password" aria-hidden="true" />
                </button>
              </span>
              <small>{usableAccounts.length} linha(s)</small>
            </span>
          </span>
          <em>Uma por linha — usuario:senha:2fa ou usuario;senha;2fa</em>
          <textarea id="bulk-accounts" value={accountsText} onChange={(event) => setAccountsText(event.target.value)} spellCheck={false} placeholder="usuario:senha:2fa ou usuario;senha;2fa" />
        </div>
        <label className="panel bulk-textarea-panel" htmlFor="bulk-proxies">
          <span><strong>Proxies (opcional)</strong><small>{proxies.length} linha(s)</small></span>
          <em>1 por linha, pareado — host:porta:usuario:senha</em>
          <textarea id="bulk-proxies" value={proxiesText} onChange={(event) => setProxiesText(event.target.value)} spellCheck={false} placeholder="host:porta:usuario:senha" />
        </label>
      </section>

      <section className="bulk-alert-stack" aria-live="polite">
        {target === 'chrome' && <p className="bulk-proxy-fixed-alert">{fixedProxyCount} de {usableAccounts.length} perfis usam a proxy fixa da importação do Chrome (mesma proxy por perfil, pra não tomar ban).</p>}
        {missingProxyCount > 0 && <p className="bulk-warning-alert">{missingProxyCount} perfil(is) ainda não têm proxy fixa. Gere o arquivo somente se eles puderem usar proxy colada depois ou nenhuma.</p>}
        {extraProxyCount > 0 && <p className="bulk-warning-alert">{extraProxyCount} proxy(s) sobrando não entram no Excel porque não há conta correspondente.</p>}
        {overLimitCount > 0 && <p className="bulk-error-alert">O MoreLogin aceita no máximo 300 linhas por importação. Baixaremos apenas as primeiras 300 válidas.</p>}
        {(invalidAccounts.length > 0 || invalidProxies.length > 0) && (
          <div className="bulk-error-alert bulk-error-list">
            <strong>Linhas inválidas encontradas</strong>
            {[...invalidAccounts, ...invalidProxies].slice(0, 8).map((error) => <span key={`${error.line}-${error.reason}`}>Linha {error.line}: {error.reason}</span>)}
          </div>
        )}
      </section>

      <section className="bulk-2fa-section" aria-label="Códigos 2FA ao vivo">
        <div className="bulk-2fa-header">
          <div>
            <span className="section-kicker">Códigos 2FA ao vivo <mark>{usableAccounts.length} conta(s)</mark></span>
            <p>Os códigos atualizam sozinhos a cada 30s. Clique nos botões para copiar login, senha ou código.</p>
          </div>
          <div className="bulk-2fa-search">
            <label htmlFor="bulk-2fa-filter">Filtrar conta</label>
            <input id="bulk-2fa-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filtrar conta..." />
            <div className="bulk-totp-timer" aria-label={`${secondsLeft} segundos restantes`}><span style={{ width: `${(secondsLeft / 30) * 100}%` }} /> </div>
            <strong>{secondsLeft}s</strong>
            <button className={`bulk-copy-visible-2fa-button ${bulkCodesCopied ? 'bulk-copy-visible-2fa-button-copied' : ''}`} type="button" onClick={() => void copyVisibleTotpCodes()} aria-label="Copiar todos os códigos 2FA visíveis em linhas">
              <span className="bulk-copy-visible-2fa-icon" aria-hidden="true" />
            </button>
          </div>
        </div>

        {filteredAccounts.length === 0 ? (
          <article className="panel empty-state bulk-empty-state"><span className="empty-state-icon" aria-hidden="true">◇</span><h2>Nenhuma conta encontrada</h2><p>Cole contas válidas ou ajuste a pesquisa para ver os códigos 2FA.</p></article>
        ) : (
          <div className="bulk-2fa-grid">
            {filteredAccounts.map((account) => {
              const code = totpState[account.id];
              const codeCopied = copiedKey === `${account.id}:2fa`;
              const loginCopied = copiedKey === `${account.id}:login`;
              const passwordCopied = copiedKey === `${account.id}:password`;
              return (
                <article className={`panel bulk-2fa-card ${code && !code.valid ? 'bulk-2fa-card-invalid' : ''} ${codeCopied ? 'bulk-2fa-card-copied' : ''}`} key={account.id}>
                  <div className="bulk-2fa-account">
                    <strong>{account.profileName}</strong>
                    <button className={`bulk-inline-copy-control ${loginCopied ? 'bulk-inline-copy-copied' : ''}`} type="button" onClick={() => void copyValue(account.login, 'Login', `${account.id}:login`)}>
                      <span className="bulk-inline-copy-value">{account.login}</span>
                      <span className="bulk-inline-copy-icon" aria-hidden="true" />
                    </button>
                    <button className={`bulk-inline-copy-control ${passwordCopied ? 'bulk-inline-copy-copied' : ''}`} type="button" onClick={() => void copyValue(account.password, 'Senha', `${account.id}:password`)}>
                      <span className="bulk-inline-copy-value">senha</span>
                      <span className="bulk-inline-copy-icon" aria-hidden="true" />
                    </button>
                    {code?.error && <small>{code.error}</small>}
                  </div>
                  <div className={`bulk-code-control ${codeCopied ? 'bulk-code-control-copied' : ''}`}>
                    <button className="bulk-code-button" type="button" onClick={() => void copyValue(code?.code ?? '', 'Código 2FA', `${account.id}:2fa`)} disabled={!code?.valid} aria-label={`Copiar código 2FA de ${account.profileName}`}>
                      <span className="bulk-code-value">{code?.code ?? '...'}</span>
                      <span className="bulk-code-copy-icon" aria-hidden="true" />
                    </button>
                    <span className="bulk-code-copied-label" aria-hidden={!codeCopied}>Copiado</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
