
import os

files = [
    r'C:\Users\10642\Desktop\Projeto principal 5 copia\templates\vendedor.html',
    r'C:\Users\10642\Desktop\Projeto principal 5 copia\templates\vendedor2.html'
]

replacements = {
    '═': '=',
    '─': '-',
    '✓': '[V]',
    '✗': '[X]',
    '—': '-',
    'í': 'i',
    'á': 'a',
    'ã': 'a',
    'ç': 'c',
    'é': 'e',
    'ê': 'e',
    'ô': 'o',
    'õ': 'o',
    'ó': 'o',
    'ú': 'u',
    'à': 'a',
    'â': 'a',
    'Í': 'I',
    'Á': 'A',
    'Ã': 'A',
    'Ç': 'C',
    'É': 'E',
    'Ê': 'E',
    'Ô': 'O',
    'Õ': 'O',
    'Ó': 'O',
    'Ú': 'U',
    'À': 'A',
    'Â': 'A',
    '°': 'o'
}

for file_path in files:
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        for old, new in replacements.items():
            content = content.replace(old, new)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Fixed {file_path}")
