// Returns distinct repeated values in the order they first repeat.
export function duplicates(values) {
  const state = new Map();
  const repeated = [];
  for (const value of values) {
    const count = state.get(value);
    if (count === undefined) state.set(value, 1);
    else if (count === 1) {
      state.set(value, 2);
      repeated.push(value);
    }
  }
  return repeated;
}
