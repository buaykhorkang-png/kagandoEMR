const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function cleanText(value, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') {
    return required ? null : '';
  }

  const cleaned = value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (cleaned.length > maxLength || (required && cleaned.length === 0)) {
    return null;
  }

  return cleaned;
}

function isDateOnly(value) {
  if (value === null || value === '') {
    return true;
  }

  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

module.exports = { cleanText, isDateOnly, isUuid };
