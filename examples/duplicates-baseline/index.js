// Returns distinct repeated values in the order they first repeat.
export function duplicates(values) {
  const seen = [];
  const repeated = [];
  for (const value of values) {
    if (seen.includes(value)) {
      if (!repeated.includes(value)) repeated.push(value);
    } else seen.push(value);
  }
  return repeated;
}
