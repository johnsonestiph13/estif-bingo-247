import csv
import json
import os

print("=" * 50)
print("🎲 Estif Bingo - Cartela Generator")
print("=" * 50)

# Path to your CSV file
csv_path = "data/chalye bingo_export_20250617.csv"

# Check if CSV exists
if not os.path.exists(csv_path):
    print(f"\n❌ ERROR: CSV file not found at {csv_path}")
    print("\nCurrent files in data folder:")
    if os.path.exists("data"):
        for f in os.listdir("data"):
            print(f"  - {f}")
    else:
        print("  data folder not found!")
    exit(1)

print(f"\n✅ Found CSV: {csv_path}")

# Read CSV file
cartelas = {}
row_count = 0

with open(csv_path, 'r', encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    header = next(reader)  # Skip header
    print(f"📋 Headers: {header}")
    
    for row in reader:
        row_count += 1
        
        if len(row) < 8:
            print(f"⚠️ Row {row_count}: Skipped (only {len(row)} columns)")
            continue
        
        try:
            # card_no is the 3rd column (index 2)
            card_no = int(row[2].strip())
            
            # Parse B column (index 3)
            b_str = row[3].strip().strip('"')
            b_nums = [int(x.strip()) for x in b_str.split(',')]
            
            # Parse I column (index 4)
            i_str = row[4].strip().strip('"')
            i_nums = [int(x.strip()) for x in i_str.split(',')]
            
            # Parse N column (index 5) - 0 becomes "FREE"
            n_str = row[5].strip().strip('"')
            n_nums = []
            for x in n_str.split(','):
                x = x.strip()
                n_nums.append("FREE" if x == '0' else int(x))
            
            # Parse G column (index 6)
            g_str = row[6].strip().strip('"')
            g_nums = [int(x.strip()) for x in g_str.split(',')]
            
            # Parse O column (index 7)
            o_str = row[7].strip().strip('"')
            o_nums = [int(x.strip()) for x in o_str.split(',')]
            
            # Create 5x5 grid
            grid = [
                [b_nums[0], i_nums[0], n_nums[0], g_nums[0], o_nums[0]],
                [b_nums[1], i_nums[1], n_nums[1], g_nums[1], o_nums[1]],
                [b_nums[2], i_nums[2], n_nums[2], g_nums[2], o_nums[2]],
                [b_nums[3], i_nums[3], n_nums[3], g_nums[3], o_nums[3]],
                [b_nums[4], i_nums[4], n_nums[4], g_nums[4], o_nums[4]]
            ]
            
            cartelas[card_no] = {
                "id": card_no,
                "grid": grid
            }
            
        except Exception as e:
            print(f"⚠️ Row {row_count}, Card {row[2]}: Error - {e}")

print(f"\n📊 Processed {row_count} rows")
print(f"✅ Generated {len(cartelas)} valid cartelas")

# Create output directory
os.makedirs("public/assets/js", exist_ok=True)

# Generate JavaScript file
output_path = "public/assets/js/cartelas.js"

with open(output_path, 'w', encoding='utf-8') as out:
    out.write("// Estif Bingo - Complete Cartelas Data\n")
    out.write(f"// Total cartelas: {len(cartelas)}\n")
    out.write(f"// Generated from: {csv_path}\n\n")
    out.write("const CARTELAS = ")
    out.write(json.dumps(cartelas, indent=2))
    out.write(";\n\n")
    out.write("""
// Helper Functions
function getCartelaGrid(cartelaId) {
    return CARTELAS[cartelaId]?.grid || null;
}

function getCartelaCount() {
    return Object.keys(CARTELAS).length;
}

function getAllCartelaIds() {
    return Object.keys(CARTELAS).map(Number);
}

function isNumberInCartela(cartelaId, number) {
    const grid = getCartelaGrid(cartelaId);
    if (!grid) return false;
    for (let row of grid) {
        if (row.includes(number)) return true;
    }
    return false;
}

function checkBingoWin(cartelaId, drawnNumbers) {
    const grid = getCartelaGrid(cartelaId);
    if (!grid) return false;
    
    const drawnSet = new Set(drawnNumbers);
    drawnSet.add("FREE");
    
    // Check rows
    for (let row of grid) {
        if (row.every(num => drawnSet.has(num))) return true;
    }
    
    // Check columns
    for (let col = 0; col < 5; col++) {
        let win = true;
        for (let row = 0; row < 5; row++) {
            if (!drawnSet.has(grid[row][col])) {
                win = false;
                break;
            }
        }
        if (win) return true;
    }
    
    // Check diagonals
    let diag1 = true, diag2 = true;
    for (let i = 0; i < 5; i++) {
        if (!drawnSet.has(grid[i][i])) diag1 = false;
        if (!drawnSet.has(grid[i][4 - i])) diag2 = false;
    }
    if (diag1 || diag2) return true;
    
    return false;
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { 
        CARTELAS, 
        getCartelaGrid, 
        getCartelaCount,
        getAllCartelaIds,
        isNumberInCartela,
        checkBingoWin
    };
}

// Make available in browser
if (typeof window !== 'undefined') {
    window.CARTELAS = CARTELAS;
    window.getCartelaGrid = getCartelaGrid;
    window.getCartelaCount = getCartelaCount;
    window.getAllCartelaIds = getAllCartelaIds;
    window.isNumberInCartela = isNumberInCartela;
    window.checkBingoWin = checkBingoWin;
}
""")

print(f"\n✅ JavaScript file created: {output_path}")
print(f"📦 File size: {os.path.getsize(output_path):,} bytes ({os.path.getsize(output_path)/1024:.1f} KB)")

# Verify the file was created
if os.path.exists(output_path):
    print("\n" + "=" * 50)
    print("✅ SUCCESS! cartelas.js has been created!")
    print("=" * 50)
    print("\n📁 Location: public/assets/js/cartelas.js")
    print("\n📄 Next steps:")
    print("1. Include in your HTML:")
    print('   <script src="/assets/js/cartelas.js"></script>')
    print("\n2. Test in browser console:")
    print("   getCartelaCount() // Should return 400")
    print("   getCartelaGrid(1) // Shows first cartela")
else:
    print("\n❌ ERROR: File was not created!")