#!/bin/bash

# Exit on error
set -e

echo "=== Android Keystore & Properties Generator ==="

# Define output files
KEYSTORE_FILE="release.jks"
PROPERTIES_FILE="keystore.properties"

# Check if keystore or properties file already exists
if [ -f "$KEYSTORE_FILE" ] || [ -f "$PROPERTIES_FILE" ]; then
    echo "Warning: $KEYSTORE_FILE or $PROPERTIES_FILE already exists."
    read -p "Do you want to overwrite them? (y/N): " OVERWRITE
    if [[ ! "$OVERWRITE" =~ ^[yY]$ ]]; then
        echo "Aborting keystore generation."
        exit 0
    fi
fi

# Prompt for inputs
read -p "Enter Key Alias [default: pidroid-release-key]: " KEY_ALIAS
KEY_ALIAS=${KEY_ALIAS:-pidroid-release-key}

# Prompt for password securely
read -s -p "Enter Keystore & Key Password (min 6 characters): " STORE_PASSWORD
echo ""

if [ ${#STORE_PASSWORD} -lt 6 ]; then
    echo "Error: Password must be at least 6 characters."
    exit 1
fi

# Prompt for DN information
read -p "Enter Common Name (CN) [default: Pidroid Dev]: " CN
CN=${CN:-Pidroid Dev}

read -p "Enter Organization (O) [default: Pidroid]: " O
O=${O:-Pidroid}

read -p "Enter Country Code (C) [default: US]: " C
C=${C:-US}

DNAME="CN=$CN, O=$O, C=$C"

echo "Generating keystore: $KEYSTORE_FILE..."

# Remove existing if overwriting
rm -f "$KEYSTORE_FILE"
rm -f "$PROPERTIES_FILE"

# Run keytool to generate keystore
keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass "$STORE_PASSWORD" \
  -keypass "$STORE_PASSWORD" \
  -dname "$DNAME"

echo "Keystore generated successfully."

# Write to keystore.properties
echo "Writing configuration to $PROPERTIES_FILE..."
cat << EOF > "$PROPERTIES_FILE"
# Keystore configuration for signing release builds
storeFile=$KEYSTORE_FILE
storePassword=$STORE_PASSWORD
keyAlias=$KEY_ALIAS
keyPassword=$STORE_PASSWORD
EOF

# Ensure keystore and properties are in .gitignore
echo "Updating .gitignore..."
for file in "$KEYSTORE_FILE" "$PROPERTIES_FILE"; do
    if ! grep -q "^$file" .gitignore 2>/dev/null; then
        echo "$file" >> .gitignore
        echo "Added $file to .gitignore"
    fi
done

echo "=== Generation Complete ==="
echo "Generated:"
echo "  - Keystore: $KEYSTORE_FILE"
echo "  - Properties: $PROPERTIES_FILE"
echo "Note: Both files have been appended to .gitignore and should NOT be committed."
