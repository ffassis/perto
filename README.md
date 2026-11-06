# Perto

Rede social por proximidade: mapa com as pessoas por perto, pedido de conversa, aceite e chat em tempo real.

## App Android (APK)
O app de celular fica em `mobile/` (Capacitor). Ele traz o mesmo Perto e mais o **modo offline**: conversa direta entre celulares por Bluetooth ou Wi-Fi, sem internet (Google Nearby Connections).

**Gerar o APK sem instalar nada (GitHub):**
1. Crie um repositório público no GitHub e envie o conteúdo desta pasta (inclusive a pasta oculta `.github`).
2. Abra a aba *Actions* → *Gerar APK*. Ele roda sozinho a cada envio (cerca de 8 min).
3. Em *Releases* aparece "Perto APK N" com o arquivo `app-debug.apk`. Mande esse link para as pessoas.
4. Quem baixar precisa permitir "instalar apps desconhecidos" no Android.

**Gerar no seu computador** (precisa de Node 20, JDK 17 e Android SDK):

    cd mobile && npm install && npx cap add android
    bash scripts/patch-android.sh && npx cap sync android
    cd android && ./gradlew assembleDebug
    # APK: android/app/build/outputs/apk/debug/app-debug.apk

No app, o modo **online** (mapa por GPS) precisa que o servidor esteja publicado na internet: informe o endereço dele na primeira tela. O modo **offline** não precisa de servidor nem de internet, mas só enxerga quem também está com o Perto aberto em modo offline e mostra uma lista, não um mapa. Exige Android com Google Play Services. Infravermelho não é usado: o emissor IR dos celulares só transmite comandos de controle remoto e não recebe dados.

## iPhone
- **Instalar como app, sem loja:** abra o endereço do servidor (HTTPS) no Safari, toque em Compartilhar e em *Adicionar à Tela de Início*. Mapa por GPS, conversas, feed, vídeos, stories, Match, moderação e avisos (iOS 16.4 ou mais novo, só pelo app da tela inicial) funcionam.
- **Modo offline (Bluetooth/Wi-Fi direto):** por enquanto só no Android.
- **App de loja:** num Mac com Xcode, `cd mobile && npm install && npx cap add ios && npx cap sync ios && npx cap open ios`. Para distribuir (TestFlight ou App Store) é preciso uma conta de desenvolvedor da Apple. Não existe "APK" no iPhone.
- Vídeos do iPhone (.mov) são aceitos, até 30 MB. O Safari costuma converter fotos HEIC em JPEG ao escolher.

## Publicar (GitHub e nuvem)
1. **GitHub:** crie um repositório público e envie o conteúdo desta pasta, incluindo a pasta oculta `.github` (use o GitHub Desktop ou os comandos `git init`, `git add .`, `git commit`, `git push`). O APK é gerado em *Actions > Gerar APK* e aparece em *Releases*.
2. **Servidor na Render:** *New > Blueprint*, escolha o repositório e confirme. O `render.yaml` cria o serviço com disco. Depois, em *Environment*, copie o valor de `ADMIN_TOKEN` (senha do painel `/admin`).
3. **APK já apontando para o seu servidor:** no repositório, *Settings > Secrets and variables > Actions > Variables*, crie `SERVER_URL` com o endereço https do servidor e rode *Gerar APK* de novo.
4. Plano gratuito da Render serve só para testar: o serviço dorme após 15 min sem uso e o disco é apagado a cada reinício.

## Rodar
    npm install
    npm start        # http://localhost:3000

O navegador só libera o GPS em **HTTPS** (ou localhost). Para testar no celular:
    npx cloudflared tunnel --url http://localhost:3000
e abra o endereço https gerado nos dois celulares. Ou publique em Render, Fly.io ou Railway.
Se precisar, defina RADIUS_M (padrão 500 m) e PORT.

## Como funciona
- Cada celular envia sua posição por WebSocket; o servidor devolve só quem está visível e dentro do raio.
- Tocar numa pessoa abre o pedido; ela aceita ou recusa; só depois disso as mensagens são entregues.
- Privacidade: posição arredondada (~11 m) para os outros, modo invisível, token de acesso nunca exposto.
- No celular, abra o site e use "Adicionar à tela inicial" para instalar como app (PWA).

## Rede social
- **Feed público:** fotos, vídeos (até 30 MB; JPG, PNG, WebP, GIF, MP4, WebM), curtidas e comentários. Qualquer pessoa conectada vê e comenta; só o autor apaga.
- **Conversas:** o servidor guarda o histórico de cada conversa aceita (até 500 mensagens), com fotos, vídeos, emojis e reações (toque numa mensagem). A aba *Conversas* lista tudo.
- Arquivos enviados ficam na pasta `uploads/` ao lado de `data.json`. Em hospedagens com disco temporário (como o plano grátis do Render), use um disco persistente ou troque por S3/R2.
- **Mensagens offline sobem sozinhas:** o que for escrito pelo modo offline (Bluetooth/Wi-Fi) fica numa fila no celular e é enviado ao servidor assim que houver internet. Cada celular envia só o que ele mesmo escreveu, e a conversa passa a aparecer no histórico quando os dois lados tiverem sincronizado (confirmação mútua). Até lá, ela fica só nos aparelhos. Fotos e vídeos (até 50 MB) também vão direto por Bluetooth/Wi-Fi e sobem junto, quando houver internet.
- As mensagens ficam legíveis para quem administra o servidor (não há criptografia de ponta a ponta).

## Moderação
- Qualquer pessoa pode denunciar post, story, mensagem ou perfil (botão ⚑). **O conteúdo some na hora para os outros** e o dono é avisado.
- O dono pode enviar uma justificativa. Um administrador abre `/admin`, vê o conteúdo, o motivo e a justificativa, e decide **Permitir** (volta ao ar) ou **Remover** (apaga de vez, inclusive o arquivo).
- Defina `ADMIN_TOKEN` (senha do painel) nas variáveis de ambiente. Sem ela, o servidor gera uma e mostra no console ao iniciar.
- 3 conteúdos removidos suspendem a conta. Quem tiver 3 denúncias recusadas deixa de ocultar conteúdo automaticamente (as denúncias dele ainda vão para o painel).
- Alguém precisa olhar o painel todos os dias, principalmente por causa de conteúdo ilegal.

## Match, vídeos, stories, figurinhas e seguir
- **Match:** só para quem marca ter 18 anos ou mais (declaração da pessoa, sem verificação de documento). Deslize para a direita (curtir) ou esquerda; curtida dos dois lados libera a conversa.
- **Vídeos:** aba em tela cheia, rolagem vertical, com curtir, comentar e denunciar.
- **Stories:** foto ou vídeo que some em 24 h, com contagem de visualizações para o autor.
- **Figurinhas:** pacote fixo de 20. **Seguir:** filtro "Seguindo" no feed.
- Só dá para publicar arquivos que você mesmo enviou.

## Segurança e dados
- Os dados (nomes, conversas aceitas, mensagens não entregues, bloqueios e denúncias) ficam em `data.json` (ou em DATA_FILE) e sobrevivem a reinícios. As denúncias ficam em `reports` nesse arquivo para você revisar.
- Mensagens para quem está offline são entregues quando a pessoa volta.
- Bloquear apaga a conversa, impede novos pedidos e esconde as duas pessoas uma da outra.
- Limites por pessoa: 5 pedidos/min, 20 mensagens/10 s, 5 denúncias/hora.

## Notificações push
- Toque em "Avisos" no app para ativar. Quem estiver offline recebe aviso de mensagem nova e de pedido aceito.
- Exige HTTPS. No iPhone (iOS 16.4 ou mais novo), primeiro use "Adicionar à tela inicial" e abra o app por lá.
- As chaves VAPID são geradas na primeira execução e guardadas em `data.json`. Em produção, defina VAPID_PUBLIC, VAPID_PRIVATE e VAPID_CONTACT (um e-mail seu) nas variáveis de ambiente.

## Falta para produção
Login com telefone ou e-mail (hoje a identidade é um token no aparelho), banco de dados de verdade
(Postgres ou SQLite) quando houver muita gente, painel para moderar denúncias e publicação nas lojas (Capacitor).
