Git式履歴管理メモアプリ

```
mkdir -p ./data/repos/notig.git
mkdir -p ./data/blobs
git init --bare ./data/repos/notig.git
cd ./data/repos/notig.git
```
別途リバプロでhttps化しないとcrypto.randomUUID が使えない
