#!/bin/bash
set -e
cd ~/Documents/Work/westmereprivatehire.co.uk
GH="$HOME/.local/bin/gh"
REPO="repos/nikodemkrajnyk-coder/westmereprivatehire.co.uk/contents"

push_file() {
  local f="$1"
  local msg="$2"
  echo "Pushing $f..."
  python3 -c "
import base64,json,subprocess
f='$f'
sha=subprocess.check_output(['$GH','api','$REPO/'+f,'-q','.sha']).decode().strip()
with open(f,'rb') as fh: content=base64.b64encode(fh.read()).decode()
payload=json.dumps({'message':'$msg','content':content,'sha':sha,'branch':'main'})
with open('/tmp/push.json','w') as ph: ph.write(payload)
r=subprocess.run(['$GH','api','$REPO/'+f,'--method','PUT','--input','/tmp/push.json'],capture_output=True,text=True)
print('OK' if r.returncode==0 else r.stderr[:300])
"
}

push_file "westmere-owner.html" "Add Send Payment Reminder button to owner app"
push_file "server/api.js" "Add payment reminder API endpoint"
push_file "server/email.js" "Add payment reminder email template (card only)"

echo "All done!"
rm -- "$0"
