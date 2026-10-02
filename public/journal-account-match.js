function journalAccountMatches(account, query) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return true;
  const values = [account.code, account.name, `${account.code} - ${account.name}`]
    .map((value) => String(value || '').toLowerCase());
  if (!term.includes('%')) return values.some((value) => value.includes(term));
  const pattern = term.split('%')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const matcher = new RegExp(pattern, 'i');
  return values.some((value) => matcher.test(value));
}

if (typeof module !== 'undefined') module.exports = { journalAccountMatches };
