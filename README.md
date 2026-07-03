# KiCad Library Automator

**Transform JLCPCB parts into organized KiCad libraries with one command.**

A Python automation tool that converts JLCPCB component part numbers into properly structured KiCad libraries and seamlessly installs them into your KiCad installation.

## 🚀 Quick Start

### Prerequisites
```bash
# Clone this repository
git clone https://github.com/your-username/kibrary-automator.git

# JLC2KiCadLib is installed automatically on first use
# (into a private virtualenv — no system pip needed)
```

### Create Your First Library
```bash
# Run the automator from anywhere — on first run it asks where your
# KiCad library repository lives and remembers it from then on
python3 /path/to/kibrary-automator/kibrary_automator.py add C1525 C25804 R25604

# Part numbers can also be entered interactively if omitted.

# Follow the interactive prompts to:
# - Set component descriptions
# - Choose reference designators  
# - Create new library or merge into existing
# - Install to KiCad automatically
```

### Install Existing Libraries to KiCad
```bash
# From anywhere
python3 /path/to/kibrary-automator/kibrary_automator.py install
```

### CLI Reference
```
kibrary_automator.py [--library-root PATH] [command]

  add [PART ...]   download JLCPCB parts and add them to a library (default)
  install          register the repository's libraries in KiCad
  package          zip the repository for a GitHub release
  config           show the stored configuration (--reset to change the path)
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
1. Run `kibrary_automator.py add C1525 ...` (from anywhere)
2. Follow interactive setup for descriptions and references
3. Choose "Create new library"
4. Optionally install to KiCad immediately

### Adding to Existing Library
1. Run `kibrary_automator.py add` with new components
2. Choose existing library from the list
3. Components are merged automatically

### Installing Libraries
```bash
# Install all libraries from your configured library repository
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
| **Flatpak (Linux)** | `~/.var/app/org.kicad.KiCad/config/kicad/` | ✅ Supported |
| **Regular Install (Linux)** | `~/.config/kicad/` | ✅ Supported |
| **macOS** | `~/Library/Preferences/kicad/` | ✅ Supported |
| **Multiple Versions** | Auto-detected | ✅ Choose target |
| **Windows** | `%APPDATA%\kicad\` | 🔄 Planned |

## 🎛️ Configuration

The location of your library repository is stored in a human-readable YAML
file, created on first run:

| Platform | Config file |
|----------|-------------|
| **Linux** | `~/.config/kibrary-automator/config.yaml` |
| **macOS** | `~/Library/Application Support/kibrary-automator/config.yaml` |

```yaml
# kibrary-automator configuration
# Edit freely — one `key: value` per line.

library_root: /home/you/kicad-shared-libs
```

Show it with `kibrary_automator.py config`, change the stored path with
`kibrary_automator.py config --reset`, or override it for a single run with
`--library-root PATH`.

For everything else, edit these variables at the top of `kibrary_automator.py`:

```python
LIB_SUFFIX    = "_KSL"           # Library name suffix
GH_USER       = "your-username"  # GitHub username for metadata
MODEL_ENV_VAR = "${KSL_ROOT}"    # 3D model path variable
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

# 3. Generate library (from anywhere — the library location is remembered)
python3 ~/tools/kibrary_automator.py add C1525 C25804 R25604

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
# Point the tool at it once
python3 tools/kibrary_automator.py config --reset

# Install all team libraries
python3 tools/kibrary_automator.py install

# Add new components
python3 tools/kibrary_automator.py add
# Merge into existing team libraries

# Share updates
cd kicad-shared-libs/
git add . && git commit -m "Add new components"
git push
```

## 🛠️ Dependencies

- **Python 3.8+** (standard library only)
- **JLC2KiCadLib**: Component conversion tool (auto-installed into a private venv)
- **KiCad**: Target installation for libraries

## 🤝 Contributing

This tool is designed to work with your specific KiCad library workflow. Contributions welcome for:
- Additional KiCad installation types
- Enhanced component organization
- Integration improvements
- Cross-platform compatibility

## 📝 License

This project follows the same license as your KiCad libraries.