# cart_totals: a cart adds its prices
. ./lib/cart.sh
[ "$(cart_total 3 4 5)" = "12" ]
