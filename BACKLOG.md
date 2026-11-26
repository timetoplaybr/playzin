# Backlog do Playzin

Funcionalidades de videogames atuais (PlayStation, Nintendo Switch, Xbox e Steam) que ainda podem
vir para o Playzin.

**Esforço:** **P** = poucas horas · **M** = parecido com uma das etapas já feitas (menu rápido,
conquistas, celular como controle...) · **G** = várias etapas.

## Já feito

Menu rápido · desligar e reiniciar pela tela · ordem dos jogadores e bateria dos controles ·
conquistas · capturas de tela · protetor de tela · remapear botões (todos os controles ou por
modelo) · celular como controle · página de detalhes do jogo · atualização do sistema pelo Wi-Fi ·
backup dos saves no pendrive · fundo com a arte do jogo.

## Prioridade sugerida

1. **Controle dos pais / limite de tempo.** O mais útil para um console de família, e os dados
   (tempo de jogo por perfil) já existem.
2. **Mandar captura para o celular.** Pouco esforço, completa as capturas e reaproveita a estrutura
   do celular como controle.

Para algo que nenhum outro console tem: **celular como segunda tela** (o maior item da lista, e mexe
no SDK).

## Mais impacto para um console de família

| Funcionalidade | Inspiração | Como ficaria no Playzin | Esforço |
|---|---|---|---|
| **Controle dos pais / limite de tempo** | Switch (app de controle parental), Xbox Family | Limite diário e horários por perfil, usando o tempo de jogo que já é contado. Aviso "faltam 10 min" por cima do jogo, pausa quando acaba e PIN para liberar. Perfis de criança e de adulto. | M |
| **Mandar captura para o celular** | Botão Share (PS5, Switch) | No álbum, "Enviar para o celular" mostra um QR code e o celular baixa a imagem. Reaproveita a porta dos celulares. Hoje as capturas não saem do console. | P |
| **Volume e saída de áudio** | Todos | Volume no menu rápido e em Configurações (PipeWire/ALSA no Pi). Saída HDMI ou fone de 3,5 mm. | P–M |
| **HDMI-CEC** | PS5, Switch | Ligar o console liga a TV, desligar deixa a TV em espera, e o controle remoto da TV navega no menu. No Pi sai quase de graça (`cec-ctl`). | M |

## Para o console parecer mais vivo

| Funcionalidade | Inspiração | Como ficaria no Playzin | Esforço |
|---|---|---|---|
| **Temas e papel de parede por perfil** | Temas do PS4/PS5, temas do Switch | Escolher uma captura como fundo do perfil, e temas claro e escuro. | P–M |
| **Resumo da semana / Retrospectiva do ano** | PS Wrap-Up, Steam Year in Review | Com o tempo de jogo, as conquistas e as capturas: jogo mais jogado, horas, conquistas do período e comparação entre os perfis da casa. | M |
| **Placar (leaderboard) do console** | Placares da Steam e do Xbox | `submitScore('fase-1', 1234)` no SDK, com o ranking entre os perfis da casa na página do jogo. Competição saudável na família. | M |
| **Perfil visitante** | Switch (convidado), Xbox | Jogar sem criar perfil: nada fica salvo, ou é descartado ao sair. | P |

## Coisas que só o Playzin faria (aproveitando o celular)

| Funcionalidade | Inspiração | Como ficaria no Playzin | Esforço |
|---|---|---|---|
| **Celular como segunda tela** | Wii U, Jackbox Games | O SDK deixa o jogo mandar **conteúdo privado para o celular de cada jogador**: cartas secretas, resposta escondida, um mapa que só um vê. Abre um gênero inteiro de jogos de festa. | G |
| **Sensor de movimento do celular** | Wii, Switch (giroscópio dos Joy-Con) | Inclinar o celular para pilotar, balançar como raquete. **Risco técnico:** no iPhone (e dependendo do navegador) o sensor só funciona com HTTPS, que o endereço local não tem. Investigar antes de prometer. | M (com risco) |
| **Digitar pelo celular** | Steam (teclado no celular), Xbox SmartGlass | Senha do Wi-Fi, nome de perfil e qualquer campo do teclado virtual digitados no celular. | P–M |

## Infraestrutura

| Funcionalidade | Inspiração | Como ficaria no Playzin | Esforço |
|---|---|---|---|
| **Instalar o cartucho no console** | Switch e jogos digitais em geral | Copiar o jogo para o armazenamento interno e jogar sem o pendrive. Atualizar o jogo a partir de um cartucho mais novo. | M |
| **Tela de armazenamento** | Todos | Espaço do cartão SD e quanto ocupam saves, capturas e versões guardadas, com limpeza. | P |
| **Acessibilidade** | Xbox, PS5 | Texto maior, alto contraste, menos animação e "segurar para apertar". | M |
| **Quick Resume (suspender o jogo)** | Xbox | Deixar o jogo pausado em segundo plano enquanto se usa o menu e voltar de onde parou. No Pi, a memória limita a um jogo por vez. | M |

## Pendências de teste no hardware

Itens já feitos que ainda precisam ser conferidos no Raspberry Pi de verdade (detalhes no README e em
`docs/raspberry-pi.md`):

- Bluetooth (BlueZ) e Wi-Fi (NetworkManager) pela tela do console
- Bateria dos controles (BlueZ `Battery1` e `/sys/class/power_supply`)
- Desligar e reiniciar (logind e polkit)
- Celular como controle com celulares de verdade (Android e iPhone), inclusive o zoom no iPhone
- Atualização pelo Wi-Fi (systemd, `update-guard.sh` e a troca do link `current`)
- Backup no pendrive (montar para escrita e voltar a somente leitura pelo UDisks2; pendrive FAT32/exFAT)
- Fonte de cartuchos UDisks2 e o kiosk
