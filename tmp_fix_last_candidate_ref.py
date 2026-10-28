from pathlib import Path

path = Path(r'c:\Users\32328\Desktop\zhiXiShuXue\backend\routes\student.js')
text = path.read_text(encoding='utf-8')
text = text.replace('const candidateQuestions = ensurePracticeQuestionsForKnowledgePoint(studentId, knowledgePointId);', 'const candidateQuestions = getPracticeQuestionsForKnowledgePoint(studentId, knowledgePointId);')
path.write_text(text, encoding='utf-8')
