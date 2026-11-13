cart_total() {
  total=0
  for price in "$@"; do total=$((total + price)); done
  printf '%s\n' "$total"
}
