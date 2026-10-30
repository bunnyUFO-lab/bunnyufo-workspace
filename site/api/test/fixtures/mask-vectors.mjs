// Shared test vectors for secret masking, as a module so both repositories can import it (the hooks only load code files).
// The same file lives at site/api/test/fixtures/mask-vectors.mjs in bunnyUFO-lab/bunnyufo-workspace and at
// mods/hub-hooks/hooks/mask-vectors.mjs in bunnyUFO-lab/workspace-skills. Keep both identical, together with the rule list in
// site/api/hub-mask.mjs and mods/hub-hooks/hooks/mask.ts. When you change this file, update MASK_VECTORS_SHA256 in both mask tests.
// Every secret is fake and split into parts (input and expected are joined) so secret scanners do not trip.
// Entries: { name, input, expected }, each a string or an array of parts.
export default [
  {"name":"bearer header keeps the scheme","input":["Authorization: Bearer ","FAKEtoken","0123456789"],"expected":"Authorization: Bearer [masked]"},
  {"name":"bearer in a curl line, lower case","input":["curl -H \"authorization: bearer ","FAKEtoken","0123456789.part-two\" https://example.test/x"],"expected":"curl -H \"authorization: bearer [masked]\" https://example.test/x"},
  {"name":"url credentials keep user and host","input":["git clone https://deploy:","FAKEpassw0rd","@example.test/repo.git"],"expected":"git clone https://deploy:[masked]@example.test/repo.git"},
  {"name":"url credentials in a database url","input":["DATABASE_URL=postgres://app:","fake-pass-1","@db.example.test:5432/app"],"expected":"DATABASE_URL=postgres://app:[masked]@db.example.test:5432/app"},
  {"name":"slack bot token","input":["token is xox","b-0000000000-FAKEFAKEFAKE here"],"expected":"token is [masked] here"},
  {"name":"slack user token","input":["xox","p-0000000000-FAKEFAKEFAKE"],"expected":"[masked]"},
  {"name":"short stripe live key","input":["key sk_","live_FAKE1234567890 end"],"expected":"key [masked] end"},
  {"name":"stripe restricted test key","input":["rk_","test_FAKE1234567890"],"expected":"[masked]"},
  {"name":"api key with a space","input":"my api key: abc123 is old","expected":"my api key: [masked] is old"},
  {"name":"API Key with a space and equals","input":"API Key = abc123","expected":"API Key = [masked]"},
  {"name":"quoted value with spaces","input":"DB_PASSWORD=\"two words here\" next","expected":"DB_PASSWORD=[masked] next"},
  {"name":"single quoted value with spaces","input":"secret: 'two words' end","expected":"secret: [masked] end"},
  {"name":"json value with spaces","input":"{\"password\": \"two words\"}","expected":"{\"password\": [masked]}"},
  {"name":"key value keeps name and separator","input":"password: hunter2 and API_KEY=abc123","expected":"password: [masked] and API_KEY=[masked]"},
  {"name":"prefixed name","input":"MY_SERVICE_API_KEY=s3cr3t_v4lue_with_underscores","expected":"MY_SERVICE_API_KEY=[masked]"},
  {"name":"sk key","input":["echo sk-ant-api03-","AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"," | x"],"expected":"echo [masked] | x"},
  {"name":"github token","input":["gh ghp_","a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2a1B2"," end"],"expected":"gh [masked] end"},
  {"name":"aws id","input":["id AKIA","ABCDEFGHIJKLMNOP."],"expected":"id [masked]."},
  {"name":"jwt","input":["jwt eyJhbGciOiJIUzI1NiJ9",".eyJzdWIiOiIxMjM0NTY3",".SflKxwRJSMeKKF2QT4fwpM ok"],"expected":"jwt [masked] ok"},
  {"name":"long hex","input":"sha abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd","expected":"sha [masked]"},
  {"name":"prose with bearer","input":"The bearer of bad news arrived. Bearer of what? Bearer instruments are fine.","expected":"The bearer of bad news arrived. Bearer of what? Bearer instruments are fine."},
  {"name":"prose with token and api key","input":"the token expired; the api key rotation is due; a secret plan; password manager","expected":"the token expired; the api key rotation is due; a secret plan; password manager"},
  {"name":"url without credentials","input":"https://example.test:8080/a/b?c=d and ssh://git@example.test/repo.git and https://example.test/p:q@r","expected":"https://example.test:8080/a/b?c=d and ssh://git@example.test/repo.git and https://example.test/p:q@r"},
  {"name":"uuid","input":"run 123e4567-e89b-12d3-a456-426614174000 done","expected":"run 123e4567-e89b-12d3-a456-426614174000 done"},
  {"name":"short sha and 32-character id","input":"fix in 8000c7d, merged a247d59f; id 0123456789abcdef0123456789abcdef","expected":"fix in 8000c7d, merged a247d59f; id 0123456789abcdef0123456789abcdef"},
  {"name":"look-alike prefixes","input":"xoxo hugs, the sk_live_ prefix, a task-list, risk_test_ing","expected":"xoxo hugs, the sk_live_ prefix, a task-list, risk_test_ing"},
  {"name":"paths and times","input":"/usr/local/bin/node at 12:30:45 in C:/Users/x/y.txt","expected":"/usr/local/bin/node at 12:30:45 in C:/Users/x/y.txt"},
  {"name":"url credentials with an empty user (redis)","input":["REDIS_URL=redis://:","fake-pass-2","@cache.example.test:6379"],"expected":"REDIS_URL=redis://:[masked]@cache.example.test:6379"},
  {"name":"discord webhook keeps the id, drops the token","input":["post to https://disc","ord.com/api/webhooks/123456789012345678/","FAKEFAKEFAKEFAKEFAKE_fake-token-0123456789"," now"],"expected":["post to https://disc","ord.com/api/webhooks/123456789012345678/[masked] now"]},
  {"name":"discord bot token","input":["bot M","FAKEFAKEFAKEFAKEFAKEFAK",".abc123.","FAKEFAKEFAKEFAKEFAKEFAKEFAK"," ok"],"expected":"bot [masked] ok"},
  {"name":"basic authorization header","input":["Authorization: Basic ","ZmFrZXVzZXI6ZmFrZXBhc3M="],"expected":"Authorization: Basic [masked]"},
  {"name":"prose with basic","input":"a basic idea. Authorization: Basic authentication is weak.","expected":"a basic idea. Authorization: Basic authentication is weak."},
  {"name":"basic authorization, digits only","input":["Authorization: Basic ","0123456789"],"expected":"Authorization: Basic [masked]"},
  {"name":"basic authorization, letters and digits","input":["Authorization: Basic ","abc12345xyz"],"expected":"Authorization: Basic [masked]"},
  {"name":"basic authorization, plain word survives","input":"Authorization: Basic understanding is key","expected":"Authorization: Basic understanding is key"},
]
