#!/bin/sh
# vendor/ の依存ソースを取得し、パッチを適用してビルドする
set -e
cd "$(dirname "$0")/.."

mkdir -p vendor

if [ ! -d vendor/strfry ]; then
  git clone --recursive https://github.com/hoytech/strfry.git vendor/strfry
fi

if [ ! -d vendor/relay29 ]; then
  git clone https://github.com/fiatjaf/relay29.git vendor/relay29
fi

cd vendor/relay29
if git apply --check ../../patches/strfry29-main-go.patch 2>/dev/null; then
  git apply ../../patches/strfry29-main-go.patch
  echo "patch applied"
else
  echo "patch already applied or not applicable; skipping"
fi

echo "== building strfry =="
cd ../strfry && make setup-golpe && make -j8

echo "== building strfry29 =="
cd ../relay29/strfry29 && go build -o strfry29 .

echo "done"
