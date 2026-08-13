{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
  };

  enterTest = ''
    npm ci
    npm run check
    npm test
  '';
}
