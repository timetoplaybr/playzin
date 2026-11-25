# Rodando o Playzin no Raspberry Pi 4

Guia passo a passo para transformar um Raspberry Pi 4 Model B num Playzin, a partir de um PC com
Windows. Quase tudo é feito pelo instalador [`scripts/pi/setup.sh`](../scripts/pi/setup.sh): ele
instala Node 22, cage, Chromium, UDisks2, BlueZ, NetworkManager, o driver xpadneo e os serviços
systemd, e deixa o Pi ligando direto no menu.

Nos comandos abaixo, troque `usuario` pelo usuário que você criar no passo 1.

## 0. O que você vai precisar

- **Fonte USB‑C de 5V/3A.** Fonte fraca dá travamentos e corrompe o cartão SD.
- **Cartão microSD** de 16 GB ou mais.
- **Cabo micro‑HDMI → HDMI** ligado na porta **HDMI0**, a mais próxima do USB‑C.
- Teclado USB, para os primeiros testes, e um pendrive para servir de cartucho.

## 1. Gravar o sistema no cartão (no PC)

1. Instale o **Raspberry Pi Imager** e escolha: *Raspberry Pi 4* → **Raspberry Pi OS Lite (64-bit)**.
   Tem que ser o **Lite**, sem desktop, porque o Playzin traz a própria tela.
2. Quando ele perguntar se quer personalizar, abra as configurações (OS customisation) e preencha:
   - **Hostname:** `playzin`
   - **Usuário e senha:** qualquer nome, **menos `playzin`**, porque o instalador cria um
     usuário com esse nome só para rodar o console.
   - **Wi‑Fi:** a rede da sua casa e o país `BR`
   - **Serviços → Ativar SSH** com senha
3. Grave, coloque o cartão no Pi, ligue a TV e a fonte. O primeiro boot leva uns 2 minutos.

## 2. Acessar o Pi pelo PC

No PowerShell do Windows (o SSH já vem no Windows 10):

```powershell
ssh usuario@playzin.local
```

Se `playzin.local` não for encontrado, procure o IP do Pi na página do seu roteador ou na própria
TV (ele aparece na tela de login) e use `ssh usuario@192.168.x.x`.

## 3. Copiar o projeto para o Pi

O repositório no GitHub é privado e usa SSH, então clonar direto no Pi exigiria configurar uma
chave lá. É mais simples mandar um pacote do código a partir do PC. Rode isto **no PC**, na pasta
do projeto:

```powershell
git archive --format=tar.gz -o "$env:TEMP\playzin.tar.gz" HEAD
scp "$env:TEMP\playzin.tar.gz" usuario@playzin.local:~
```

Esse pacote leva só os arquivos do git, sem o `node_modules` do Windows, e com as quebras de linha
certas para Linux (o `.gitattributes` já cuida disso). Se você tiver alterações sem commit, faça o
commit antes, senão elas ficam de fora.

Depois, **no Pi** (pelo SSH):

```bash
mkdir -p ~/playzin && tar -xzf ~/playzin.tar.gz -C ~/playzin
cd ~/playzin
```

## 4. Rodar o instalador

Primeiro, atualize o sistema e reinicie:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo reboot
```

Isso evita um problema conhecido: se o kernel for atualizado no meio da instalação, a compilação
do xpadneo falha por falta de reboot.

Depois que ele voltar (o `ssh` de novo):

```bash
cd ~/playzin
sudo ./scripts/pi/setup.sh
```

- A instalação leva de **10 a 20 minutos**. O `npm install` e o build no Pi são lentos, e o
  xpadneo é compilado na hora.
- Se o xpadneo der erro, o setup avisa e continua. O console funciona normalmente, só o controle
  de Xbox fica com os botões no mapeamento genérico. Para pular o driver:
  `sudo ./scripts/pi/setup.sh --sem-xpadneo`.

Ao terminar:

```bash
sudo reboot
```

A TV deve mostrar a abertura do Playzin e depois a criação do primeiro perfil.

## 5. Testar o cartucho

No **PC**, grave o cartucho de exemplo num pendrive. Troque `E:\` pela letra do seu pendrive; o
pendrive é apagado antes, a não ser que já esteja vazio ou já seja um cartucho Playzin:

```powershell
npm run cart:pack -- E:\
```

Plugue o pendrive no Pi: o jogo deve aparecer primeiro na fileira. Use as portas **USB 2.0, as
pretas**; as azuis (USB 3) interferem no Wi‑Fi e no Bluetooth de 2,4 GHz.

## 6. Ver o que está acontecendo (pelo SSH)

```bash
journalctl -u playzin-daemon -f    # cartuchos, Bluetooth, Wi-Fi
journalctl -u playzin-kiosk -f     # Chromium / tela
sudo systemctl restart playzin-kiosk
```

**Abrir o menu do Pi no navegador do PC:** o daemon só escuta em `127.0.0.1`, de propósito. Para
acessá-lo do PC, crie um túnel:

```powershell
ssh -L 7777:127.0.0.1:7777 usuario@playzin.local
```

Com o túnel aberto, acesse **http://localhost:7777** no PC. Isso ajuda a depurar com o DevTools.

## 7. Atualizar o código depois

Repita o passo 3 (gerar o pacote, mandar com `scp`, extrair) e rode
`sudo ./scripts/pi/setup.sh` de novo. Ele recopia, recompila e reinicia tudo, e os saves ficam
guardados em `/var/lib/playzin`, que não é apagado.

## O que vale testar com atenção

São os itens que o README ainda marca como não testados no hardware:

1. **Kiosk:** a tela abre sozinha, aparece som pelo HDMI e o desempenho do Chromium é aceitável.
2. **UDisks2:** plugar e puxar o pendrive com o jogo aberto, e verificar se o progresso foi salvo.
3. **Wi‑Fi** pela tela do console (NetworkManager).
4. **Bluetooth:** parear um controle pela tela Controles.
5. **Desligar e reiniciar** pelo ícone Desligar da tela inicial: a TV fica sem sinal (desligar)
   ou o console volta sozinho para o menu (reiniciar). Se aparecer um aviso de permissão,
   confira se existe `/etc/polkit-1/rules.d/50-playzin-power.rules`.
6. **Bateria dos controles:** com o controle ligado, Controles mostra a porcentagem. Se não
   aparecer, veja o que o sistema enxerga: `ls /sys/class/power_supply/` e
   `busctl tree org.bluez | grep -i battery`.

**Não ligue o Overlay File System** (o modo somente leitura) por enquanto: com ele ativo, os saves
se perdem a cada reboot.
