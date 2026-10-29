# /etc/nginx/apps.badita.com.d/bash-headers.inc
# A location with add_header drops the server's add_header lines: re-add them here.
add_header Strict-Transport-Security "max-age=31536000" always;
add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
add_header X-Content-Type-Options    "nosniff" always;
# Everything is same-origin static files. 'unsafe-inline' styles: xterm.js
# writes its theme into a <style> element at run time. No inline scripts.
add_header Content-Security-Policy   "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
