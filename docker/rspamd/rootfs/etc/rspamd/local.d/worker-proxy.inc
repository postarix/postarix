# Milter endpoint for Postfix. The proxy scans messages itself.
bind_socket = "*:11332";
milter = yes;
timeout = 120s;
upstream "local" {
  default = yes;
  self_scan = yes;
}
