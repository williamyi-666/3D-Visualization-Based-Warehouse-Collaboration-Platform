#!/bin/sh
# 用法：sh tools/create-lan-cert.sh /安全目录/仓储证书 192.168.3.30
# 只生成测试证书，不自动安装信任；仅将 warehouse-ca.crt 提供给测试设备。
set -eu
cert_dir=${1:?请指定证书输出目录}
lan_ip=${2:?请指定局域网IPv4地址}
case "$lan_ip" in *[!0-9.]*|'') echo '请提供IPv4地址' >&2; exit 1;; esac
if [ -e "$cert_dir/server.key" ] || [ -e "$cert_dir/warehouse-ca.key" ]; then
  echo '目录已有私钥，拒绝覆盖；请复用原证书或指定新目录。' >&2; exit 1
fi
umask 077
mkdir -p "$cert_dir"
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -subj '/CN=Warehouse LAN Test CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$cert_dir/warehouse-ca.key" -out "$cert_dir/warehouse-ca.crt"
openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$lan_ip" \
  -keyout "$cert_dir/server.key" -out "$cert_dir/server.csr"
cat > "$cert_dir/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$lan_ip,IP:127.0.0.1,DNS:localhost
EOF
openssl x509 -req -in "$cert_dir/server.csr" -CA "$cert_dir/warehouse-ca.crt" \
  -CAkey "$cert_dir/warehouse-ca.key" -CAcreateserial -days 90 -sha256 \
  -extfile "$cert_dir/server.ext" -out "$cert_dir/server.crt"
openssl verify -CAfile "$cert_dir/warehouse-ca.crt" -verify_ip "$lan_ip" "$cert_dir/server.crt"
printf '证书已生成。手机仅需导入公开CA证书：%s/warehouse-ca.crt\n' "$cert_dir"
