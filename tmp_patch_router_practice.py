from pathlib import Path
p = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\frontend\src\router\index.js')
text = p.read_text(encoding='utf-8')
text = text.replace("component: function () { return import('@/views/student/Practice.vue') }", "component: function () { return import('@/views/student/WeakPractice.vue') }")
p.write_text(text, encoding='utf-8')
print('patched router')
