export function redactPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 6) return value;
  const head = value.slice(0, 3);
  const tail = value.slice(-4);
  return `${head}****${tail}`;
}

export function redactText(value: string): string {
  // Treat >6 total digit characters as phone-like sensitive content: mask contiguous 7+ digit runs in place;
  // mask the whole string for scattered digits (separated groups)
  const digitCount = value.replace(/\D/g, '').length;
  if (digitCount <= 6) return value;
  if (/\d{7,}/.test(value)) {
    return value.replace(/\d{7,}/g, (run) => `${run.slice(0, 3)}****${run.slice(-4)}`);
  }
  return redactPhone(value);
}

