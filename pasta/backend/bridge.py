from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import requests
import json
import os

app = Flask(__name__)
CORS(app)

# --- SERVIDOR DE ARQUIVOS (Para acesso pelo Celular) ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
print(f"Diretorio base do servidor: {BASE_DIR}")

@app.route('/')
def serve_index():
    print(">>> Acessando Painel Principal (index.html)")
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/vendedor')
@app.route('/vendedor.html')
def serve_vendedor():
    print(">>> Acessando App do Vendedor (vendedor.html)")
    return send_from_directory(BASE_DIR, 'vendedor.html')

@app.route('/<path:path>')
def serve_static(path):
    # Tenta servir qualquer arquivo solicitado (css, js, etc)
    return send_from_directory(BASE_DIR, path)

# Armazenamento temporário em memória para localizações
vendor_locations = {}

from datetime import datetime, timedelta

@app.route('/sync-sap', methods=['GET'])
def sync_sap():
    start_date_str = request.args.get('start')
    end_date_str = request.args.get('end')
    user = request.args.get('user')
    password = request.args.get('pass')

    if not start_date_str or not end_date_str:
        return jsonify({"error": "Datas inicial ou final não informadas"}), 400
    
    try:
        start_date = datetime.strptime(start_date_str, "%Y-%m-%d")
        end_date = datetime.strptime(end_date_str, "%Y-%m-%d")
        
        # Proteção contra loop infinito por erro do usuário
        if (end_date - start_date).days > 60:
            return jsonify({"error": "O intervalo máximo permitido é de 60 dias"}), 400

        all_results = []
        current_date = start_date
        
        print(f"\n--- INICIANDO LOTE SAP: {start_date_str} ate {end_date_str} ---")
        
        while current_date <= end_date:
            cur_str = current_date.strftime("%Y-%m-%d")
            sap_url = f"http://marrocos.uni.local:8000/sap/opu/odata/sap/ZC_ROTAS_CDS/ZC_ROTAS(p_data=datetime'{cur_str}T00:00:00')/Set?$format=json"
            
            print(f"Buscando dia: {cur_str}...")
            auth = (user, password) if user and password else None
            response = requests.get(sap_url, auth=auth, timeout=20)
            
            if response.status_code == 401:
                return jsonify({"error": "Usuario ou Senha do SAP incorretos."}), 401
                
            response.raise_for_status()
            data = response.json()
            
            if "d" in data and "results" in data["d"]:
                all_results.extend(data["d"]["results"])
                
            current_date += timedelta(days=1)
            
        print(f"--- LOTE FINALIZADO: {len(all_results)} registros totais ---")
        
        # Simular estrutura original de resposta D.results para o frontend manter o parser
        combined_data = {"d": {"results": all_results}}
        
        # Backup local opcional
        try:
            with open('sap_data_last.json', 'w', encoding='utf-8') as f:
                json.dump(combined_data, f, ensure_ascii=False, indent=2)
        except: pass
            
        return jsonify(combined_data)

        
    except Exception as e:
        print(f">>> ERRO GERAL: {str(e)}")
        return jsonify({"error": f"Erro de Conexao: {str(e)}"}), 500

@app.route('/update-location', methods=['POST'])
def update_location():
    try:
        data = request.json
        vendedor = data.get('vendedor', 'vendedor_01')
        vendor_locations[vendedor] = {
            "lat": float(data.get('lat')),
            "lon": float(data.get('lon')),
            "timestamp": data.get('timestamp'),
            "status": "Online"
        }
        print(f"GPS Update: {vendedor} -> {data.get('lat')}, {data.get('lon')}")
        return jsonify({"status": "ok"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route('/get-locations', methods=['GET'])
def get_locations():
    return jsonify(vendor_locations)

if __name__ == '__main__':
    print("--- PONTE SAP UNILIDER ATIVA (GPS MONITORING + UNIROTAS MEETINGS ENABLED) ---")
    print("Ouvindo em: http://127.0.0.1:5000")
    # Nota: Em ambiente Windows o 'debug=True' pode exigir reinicialização manual se o processo travar
    app.run(port=5000, host='0.0.0.0', debug=False)