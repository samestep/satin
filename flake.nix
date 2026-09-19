{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs: rec {
        default = pkgs.callPackage ./default.nix {
          version = toString (self.lastModified or 0);
        };
        icon = pkgs.runCommand "satin.svg" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
          node ${./logo/render.mjs} > "$out"
        '';
      });
    };
}
