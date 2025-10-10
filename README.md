# KiCad Library Automator

**Transform JLCPCB parts into organized KiCad libraries with one command.**

A Python automation tool that converts JLCPCB component part numbers into properly structured KiCad libraries and seamlessly installs them into your KiCad installation.

## 🚀 Quick Start

### Prerequisites
```bash
# Install JLC2KiCadLib
pip install JLC2KiCadLib

# Clone this repository
git clone https://github.com/your-username/kibrary-automator.git
```

### Create Your First Library
```bash
# Navigate to your library workspace
cd /path/to/your/kicad-shared-libs/

# Run the automator
python3 /path/to/kibrary-automator/kibrary_automator.py

# When prompted, enter JLCPCB part numbers (space-separated)
# Example: C1525 C25804 R25604

# Follow the interactive prompts to:
# - Set component descriptions
# - Choose reference designators  
# - Create new library or merge into existing
# - Install to KiCad automatically
```

### Install Existing Libraries to KiCad
```bash
# From your library directory
python3 /path/to/kibrary-automator/kibrary_automator.py install
```

## 🎯 What It Does

### 1. **Component Generation**
- Fetches JLCPCB parts using JLC2KiCadLib
- Converts to KiCad symbols, footprints, and 3D models
- Organizes files into proper KiCad library structure

### 2. **Smart Library Management**
- Creates new libraries with proper naming (`ComponentType_KSL`)
- Merges components into existing libraries
- Handles duplicate detection
- Generates KiCad Package Manager metadata

### 3. **KiCad Integration**
- Auto-detects KiCad installations (Flatpak, regular, multiple versions)
- Adds libraries to symbol and footprint tables
- Uses absolute paths for reliability
- Creates automatic backups before modifications

### 4. **3D Model Handling**
- Configures 3D model paths with `${KSL_ROOT}` environment variable
- Maintains proper model references across library structures

## 📁 Generated Library Structure

```
YourLibrary_KSL/
├── YourLibrary_KSL.kicad_sym          # Symbol definitions
├── YourLibrary_KSL.pretty/            # Footprint files
│   ├── Component1.kicad_mod
│   └── Component2.kicad_mod
├── YourLibrary_KSL.3dshapes/          # 3D models
│   ├── Component1.step
│   └── Component2.wrl
├── metadata.json                       # Package manager data
└── icon.png                          # Library icon
```

## 🔧 Usage Scenarios

### Creating a New Component Library
1. Start in your library workspace directory
2. Run `kibrary_automator.py`
3. Enter JLCPCB part numbers when prompted
4. Follow interactive setup for descriptions and references
5. Choose "Create new library"
6. Optionally install to KiCad immediately

### Adding to Existing Library
1. Run `kibrary_automator.py` with new components
2. Choose existing library from the list
3. Components are merged automatically

### Installing Libraries
```bash
# Install all libraries in current directory
python3 kibrary_automator.py install

# The script will:
# ✓ Detect your KiCad installation
# ✓ Show installation details for confirmation  
# ✓ Add libraries to sym-lib-table and fp-lib-table
# ✓ Create backups of your configuration
# ✓ Skip already installed libraries
```

### Batch Operations
```bash
# Multiple part numbers in one go
# Input: C1525 C25804 R25604 L5819 D4878

# Creates organized library with:
# - Capacitors, resistors, inductors, diodes
# - Proper categorization
# - Complete 3D models
# - Ready for KiCad use
```

## 🖥️ Supported KiCad Installations

| Installation Type | Configuration Path | Status |
|------------------|-------------------|---------|
| **Flatpak** | `~/.var/app/org.kicad.KiCad/config/kicad/` | ✅ Supported |
| **Regular Install** | `~/.config/kicad/` | ✅ Supported |
| **Multiple Versions** | Auto-detected | ✅ Choose target |
| **Windows** | `%APPDATA%\kicad\` | 🔄 Planned |
| **macOS** | `~/Library/Preferences/kicad/` | 🔄 Planned |

## 🎛️ Configuration

Edit these variables in `kibrary_automator.py`:

```python
LIB_SUFFIX = "_KSL"           # Library name suffix
GH_USER    = "your-username"  # GitHub username for metadata
ENV_VAR    = "${KSL_ROOT}"    # 3D model path variable
```

## 🔍 Interactive Features

### Smart Menus
- **No components found**: Choose between downloading new parts or installing existing libraries
- **Multiple KiCad installs**: Select target installation
- **Library selection**: Create new or merge into existing

### Safety Features
- **Backup creation**: Automatic backups of library tables
- **Duplicate detection**: Prevents conflicts with existing components
- **Path validation**: Ensures library files exist before installation
- **User confirmation**: Clear prompts for destructive operations

### Progress Feedback
```
→ Found 5 libraries: LED_KSL, MCU_KSL, Connector_KSL...
→ Installing to Flatpak KiCad 9.0
→ Backup created: sym-lib-table.backup
→ Added 'LED_KSL' to sym-lib-table
→ Installation complete! Added 5 libraries to KiCad.
→ Restart KiCad to see the new libraries.
```

## 🔄 Workflow Examples

### Electronics Engineer Workflow
```bash
# 1. Research components on JLCPCB
# 2. Copy part numbers: C1525 C25804 R25604

# 3. Generate library
cd ~/kicad-libraries/
python3 ~/tools/kibrary_automator.py
# Enter: C1525 C25804 R25604

# 4. Components automatically:
#    - Downloaded and converted
#    - Organized into library
#    - Installed to KiCad
#    - Ready for schematic design
```

### Team Library Management
```bash
# Centralized library repository
git clone https://github.com/team/kicad-shared-libs.git
cd kicad-shared-libs/

# Install all team libraries
python3 ../tools/kibrary_automator.py install

# Add new components
python3 ../tools/kibrary_automator.py
# Merge into existing team libraries

# Share updates
git add . && git commit -m "Add new components"
git push
```

## 🛠️ Dependencies

- **Python 3.6+**
- **JLC2KiCadLib**: Component conversion tool
- **KiCad**: Target installation for libraries

## 🤝 Contributing

This tool is designed to work with your specific KiCad library workflow. Contributions welcome for:
- Additional KiCad installation types
- Enhanced component organization
- Integration improvements
- Cross-platform compatibility

## 📝 License

This project follows the same license as your KiCad libraries.